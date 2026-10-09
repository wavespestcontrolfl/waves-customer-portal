// GATE_LAWN_COST_PLUS_LIST (owner 2026-10-09): residential recurring lawn care
// is listed at cost / (1 - 0.45), never below the market table, at least $55 a
// visit; discounts stop at the 35% collected-margin floor. Ships OFF: off must
// price exactly as before, and a saved estimate replays as it was priced.
const {
  generateEstimate,
  priceLawnCare,
  priceOneTimeLawn,
} = require('../services/pricing-engine');
const constants = require('../services/pricing-engine/constants');
const { savedFloorReplaySignals } = require('../services/estimate-floor-signal-replay');
const { nonPestTierBaseMap } = require('../routes/estimate-public');
const { sanitizeClientIdentityFields } = require('../services/estimate-client-identity-fields');
const { validatePricingConfigData } = require('../routes/admin-pricing-config');
const { computePublicPricingRanges } = require('../services/pricing-engine/public-ranges');

const { LAWN_PRICING_V2 } = constants;
const GATE = 'GATE_LAWN_COST_PLUS_LIST';

let priorGate;
beforeEach(() => {
  priorGate = process.env[GATE];
  delete process.env[GATE];
});
afterEach(() => {
  if (priorGate === undefined) delete process.env[GATE];
  else process.env[GATE] = priorGate;
});

const byVisits = (result) => Object.fromEntries(result.tiers.map((t) => [t.visits, t]));
const price = (lawnSqFt, options = {}) => priceLawnCare(
  { lawnSqFt },
  { track: 'st_augustine', includeHiddenTiers: true, ...options },
);
const ON = { costPlusList: true };
const OFF = { costPlusList: false };

// Table sizes the market grid prices (500 to 20,000 in 500 steps).
const SIZES = Array.from({ length: 40 }, (_, i) => 500 * (i + 1));

function estimateInput(services, extra = {}) {
  return {
    homeSqFt: 2000,
    stories: 1,
    lotSqFt: 10000,
    propertyType: 'single_family',
    features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
    measuredTurfSf: 4500,
    paymentMethod: 'card',
    services,
    ...extra,
  };
}
const lawnService = (lawn = {}) => ({ track: 'st_augustine', tier: 'enhanced', lawnFreq: 9, ...lawn });
const lawnLine = (estimate) => estimate.lineItems.find((i) => i.service === 'lawn_care');
const fourServices = (lawn) => ({
  pest: { frequency: 'quarterly' },
  lawn: lawnService(lawn),
  treeShrub: { tier: 'enhanced' },
  mosquito: { tier: 'silver' },
});

describe('gate OFF: nothing moves', () => {
  test('priceLawnCare is identical to an explicit costPlusList:false, with no new row fields', () => {
    for (const sqft of [1500, 3000, 4500, 8000, 12000, 20000, 26000]) {
      for (const track of ['st_augustine', 'bermuda']) {
        const followed = price(sqft, { track });
        expect(followed).toEqual(price(sqft, { track, ...OFF }));
        for (const tier of followed.tiers) {
          expect(tier).not.toHaveProperty('costPlusListApplied');
          expect(tier).not.toHaveProperty('listMargin');
          expect(tier).not.toHaveProperty('costPlusListAnnual');
        }
      }
    }
  });

  test('market anchors stay the table price on both sold cadences', () => {
    const at4500 = byVisits(price(4500));
    expect(at4500[9].annual).toBe(576);
    expect(at4500[9].pricingSource).toBe('MARKET_TABLE');
    expect(byVisits(price(3000))[9].annual).toBe(528);
  });

  test('generateEstimate output is identical to an explicit false (floors still disarmed)', () => {
    const services = fourServices();
    const followed = generateEstimate(estimateInput(services));
    const explicit = generateEstimate(estimateInput(fourServices({ costPlusList: false })));
    expect(explicit.lineItems).toEqual(followed.lineItems);
    expect(explicit.summary).toEqual(followed.summary);
    expect(lawnLine(followed).annual).toBe(576);
    expect(followed.pricingMetadata.lawnCostPlusList).toBe(false);
    expect(followed.pricingMetadata.lawnCostFloorArmed).toBe(false);
  });
});

describe('gate ON: cost-plus list price', () => {
  test('4,500 sq ft, 9 visits: literal anchors', () => {
    const t = byVisits(price(4500, ON))[9];
    expect(t.costFloorDetails.annualCost).toBe(380.06);
    expect(t.perApp).toBe(77);
    expect(t.annual).toBe(693);
    expect(t.minimumCollectedAnnualPrice).toBe(584.71);
    expect(t.pricingSource).toBe('COST_PLUS_LIST');
    expect(t.pricingBasis).toBe('COST_PLUS_LIST_MARGIN');
    expect(t.costPlusListApplied).toBe(true);
    expect(t.listMargin).toBe(0.45);
    expect(t.costPlusListAnnual).toBe(693);
    expect(t.marketAnnual).toBe(576);
  });

  test('anchors match the formula, not just the literals', () => {
    // v13 product $24.50 per 1,000 sq ft a year (9 visits), 22 labor minutes
    // base (12 + 10 spot) plus 2.5 per 1,000 sq ft, at the default route.
    const t = byVisits(price(4500, ON))[9];
    const cost = t.costFloorDetails.annualCost;
    expect(t.costFloorDetails.annualMaterial).toBeCloseTo(24.5 * 4.5, 2);
    expect(t.costFloorDetails.laborMinutesPerVisit).toBeCloseTo(22 + 2.5 * 4.5, 2);
    expect(t.perApp).toBe(Math.ceil(cost / 0.55 / 9));
    expect(t.minimumCollectedAnnualPrice).toBeCloseTo(cost / 0.65, 1);
  });

  test('3,600 sq ft, 9 visits: literal anchors', () => {
    const t = byVisits(price(3600, ON))[9];
    expect(t.perApp).toBe(70);
    expect(t.annual).toBe(630);
  });

  test('the lawn size is priced as given, with no size rounding', () => {
    const a = byVisits(price(4500, ON))[9].costFloorDetails.annualCost;
    const b = byVisits(price(4540, ON))[9].costFloorDetails.annualCost;
    expect(b).toBeGreaterThan(a);
    expect(price(4540, ON).lawnSqFt).toBe(4540);
  });

  test('the $55 per-visit minimum binds on a tiny lawn and is labeled', () => {
    const tiers = byVisits(price(500, ON));
    for (const visits of [9, 12]) {
      expect(tiers[visits].perApp).toBe(55);
      expect(tiers[visits].annual).toBe(55 * visits);
      expect(tiers[visits].pricingSource).toBe('MINIMUM_PER_VISIT');
      expect(tiers[visits].pricingBasis).toBe('MINIMUM_PER_VISIT_PRICE');
      expect(tiers[visits].costPlusListApplied).toBe(false);
    }
  });

  test('a market price above the cost-plus list stays the market label', () => {
    // 6x is the hidden anchor: at 3,000 sq ft its market price (456) is above its list.
    const t6 = byVisits(price(3000, ON))[6];
    expect(t6.annual).toBe(t6.marketAnnual);
    expect(t6.pricingSource).toBe('MARKET_TABLE');
    expect(t6.costPlusListApplied).toBe(false);
  });

  test('price per 1,000 sq ft strictly decreases as the lawn grows (2,000 to 20,000)', () => {
    for (const visits of [9, 12]) {
      let prior = Infinity;
      for (let sqft = 2000; sqft <= 20000; sqft += 500) {
        const perK = byVisits(price(sqft, ON))[visits].perApp / (sqft / 1000);
        expect(perK).toBeLessThan(prior);
        prior = perK;
      }
    }
  });

  test('12 visits never cost more per application than 9, and the whole ladder holds', () => {
    for (const sqft of SIZES) {
      const t = byVisits(price(sqft, ON));
      expect(t[12].perApp).toBeLessThanOrEqual(t[9].perApp);
      // The hidden 6x anchor keeps the cadence discount ladder (cadence lift).
      expect(t[9].perApp).toBeLessThanOrEqual(t[6].perApp * 0.96 + 0.01);
      expect(t[12].perApp).toBeLessThanOrEqual(t[6].perApp * 0.92 + 0.01);
    }
  });

  test('never below the market table, at any table size or cadence', () => {
    for (const sqft of SIZES) {
      for (const tier of price(sqft, ON).tiers) {
        expect(tier.annual).toBeGreaterThanOrEqual(tier.marketAnnual);
        expect(tier.annual).toBeGreaterThanOrEqual(55 * tier.visits);
      }
    }
  });

  test('line margin uses the same v13 cost', () => {
    const lawn = price(4500, { ...ON, tier: 'enhanced' });
    const selected = lawn.selected;
    expect(lawn.costs.total).toBe(selected.costFloorDetails.annualCost);
    expect(lawn.margin).toBeCloseTo((selected.annual - selected.costFloorDetails.annualCost) / selected.annual, 3);
  });

  test('explicit caller cost overrides still win over the v13 cost', () => {
    const base = byVisits(price(4500, ON))[9].costFloorDetails;
    const override = byVisits(price(4500, { ...ON, lawnMaterialCostPerK: 40, lawnLaborMinutesBase: 40 }))[9].costFloorDetails;
    expect(override.annualMaterial).toBeCloseTo(40 * 4.5 * 9, 1);
    expect(override.annualLabor).toBeGreaterThan(base.annualLabor);
  });

  test('the one-time lawn anchor stays on the market table', () => {
    const one = (opts) => priceOneTimeLawn({ lawnSqFt: 4500 }, { treatmentType: 'weed', isRecurringCustomer: false, ...opts });
    const off = one();
    process.env[GATE] = 'true';
    const on = one();
    expect(on.price).toBe(off.price);
    expect(on.baselinePricingSource).toBe('MARKET_TABLE');
  });
});

describe('mode resolution', () => {
  test('priceLawnCare follows the live gate; an explicit boolean wins either way', () => {
    process.env[GATE] = 'true';
    expect(byVisits(price(4500))[9].annual).toBe(693);
    expect(byVisits(price(4500, OFF))[9].annual).toBe(576);
    delete process.env[GATE];
    expect(byVisits(price(4500))[9].annual).toBe(576);
    expect(byVisits(price(4500, ON))[9].annual).toBe(693);
  });

  test('only a strict opt-in turns the gate on', () => {
    for (const value of ['false', '0', 'no', '']) {
      process.env[GATE] = value;
      expect(byVisits(price(4500))[9].annual).toBe(576);
    }
    for (const value of ['true', '1', 'on']) {
      process.env[GATE] = value;
      expect(byVisits(price(4500))[9].annual).toBe(693);
    }
  });

  test('generateEstimate: gate on prices cost-plus, stamps the mode and arms the cost floor', () => {
    process.env[GATE] = 'true';
    const estimate = generateEstimate(estimateInput({ lawn: lawnService() }));
    expect(lawnLine(estimate).annual).toBe(693);
    expect(estimate.pricingMetadata.lawnCostPlusList).toBe(true);
    expect(estimate.pricingMetadata.lawnCostFloorArmed).toBe(true);
  });

  test('generateEstimate: explicit false with the gate on prices market', () => {
    process.env[GATE] = 'true';
    for (const input of [
      estimateInput({ lawn: lawnService({ costPlusList: false }) }),
      estimateInput({ lawn: lawnService() }, { lawnCostPlusList: false }),
    ]) {
      const estimate = generateEstimate(input);
      expect(lawnLine(estimate).annual).toBe(576);
      expect(estimate.pricingMetadata.lawnCostPlusList).toBe(false);
      expect(estimate.pricingMetadata.lawnCostFloorArmed).toBe(false);
    }
  });

  test('generateEstimate: explicit true with the gate off prices cost-plus', () => {
    for (const input of [
      estimateInput({ lawn: lawnService({ costPlusList: true }) }),
      estimateInput({ lawn: lawnService() }, { lawnCostPlusList: true }),
    ]) {
      const estimate = generateEstimate(input);
      expect(lawnLine(estimate).annual).toBe(693);
      expect(estimate.pricingMetadata.lawnCostPlusList).toBe(true);
    }
  });
});

describe('discounts stop at the 35% margin floor', () => {
  test('Platinum 20% on 4,500 sq ft stops at the floor; Silver 10% applies in full', () => {
    const platinum = generateEstimate(estimateInput(fourServices({ costPlusList: true })));
    expect(platinum.waveGuard.tier).toBe('platinum');
    const p = lawnLine(platinum);
    expect(p.annual).toBe(693);
    expect(p.minimumCollectedAnnualPrice).toBe(584.71);
    // 693 x 0.80 = 554.40 is below the floor, so the guard holds the line at it.
    expect(p.annualAfterDiscount).toBeGreaterThanOrEqual(584.71);
    expect(p.annualAfterDiscount).toBeLessThan(693);

    const silver = generateEstimate(estimateInput({
      pest: { frequency: 'quarterly' },
      lawn: lawnService({ costPlusList: true }),
    }));
    expect(silver.waveGuard.tier).toBe('silver');
    expect(lawnLine(silver).annualAfterDiscount).toBeCloseTo(693 * 0.9, 2);
  });

  test('a manual discount on the lawn line stops at the same floor', () => {
    const estimate = generateEstimate(estimateInput(
      { lawn: lawnService({ costPlusList: true }) },
      { manualDiscount: { type: 'PERCENT', value: 50 } },
    ));
    expect(estimate.summary.recurringAnnualAfterDiscount).toBeGreaterThanOrEqual(584.71 - 0.01);
    expect(estimate.summary.manualDiscount).toEqual(expect.objectContaining({ capped: true }));
  });
});

describe('saved estimates replay as they were priced', () => {
  const replay = (input, saved) => generateEstimate({ ...input, ...savedFloorReplaySignals({ result: saved }) });

  test('priced ON, gate now OFF: replays ON', () => {
    process.env[GATE] = 'true';
    const input = estimateInput({ lawn: lawnService() });
    const saved = generateEstimate(input);
    delete process.env[GATE];
    const again = replay(input, saved);
    expect(lawnLine(again).annual).toBe(693);
    expect(again.pricingMetadata.lawnCostPlusList).toBe(true);
    expect(again.pricingMetadata.lawnCostFloorArmed).toBe(true);
  });

  test('priced OFF, gate now ON: replays OFF', () => {
    const input = estimateInput({ lawn: lawnService() });
    const saved = generateEstimate(input);
    process.env[GATE] = 'true';
    const again = replay(input, saved);
    expect(lawnLine(again).annual).toBe(576);
    expect(again.pricingMetadata.lawnCostPlusList).toBe(false);
  });

  test('an estimate saved before this change (no stamp) replays OFF with the gate ON', () => {
    const input = estimateInput({ lawn: lawnService() });
    const legacy = {
      pricingMetadata: { lawnCostFloorArmed: false, lawnProgramMinimumMonthly: 0 },
      lineItems: [{ service: 'lawn_care', annual: 576 }],
    };
    expect(savedFloorReplaySignals({ result: legacy }).lawnCostPlusList).toBe(false);
    process.env[GATE] = 'true';
    expect(lawnLine(replay(input, legacy)).annual).toBe(576);
  });

  test('the customer ladder takes the engine rows: cost-plus prices and the margin floor ride through', () => {
    const lawn = lawnLine(generateEstimate(estimateInput({ lawn: lawnService({ costPlusList: true }) })));
    const rows = lawn.tiers.map((t) => ({
      v: t.visits, mo: t.monthly, ann: t.annual, pa: t.perApp,
      recommended: t.recommended, name: t.label,
      prov: { costFloorAnnual: t.costFloorAnnual },
    }));
    const map = nonPestTierBaseMap({ lawn: rows }, undefined, { lawnCostFloorArmed: true });
    const enhanced = Object.values(map.lawn_care).find((t) => t.v === 9);
    expect(enhanced.ann).toBe(693);
    expect(enhanced.floorMonthly).toBe(Math.ceil((584.71 / 12) * 100) / 100);
  });
});

describe('replay at the knobs a quote was priced with', () => {
  let liveKnobs;
  beforeEach(() => { liveKnobs = JSON.parse(JSON.stringify(LAWN_PRICING_V2.costPlusList)); });
  afterEach(() => { LAWN_PRICING_V2.costPlusList = liveKnobs; });

  test('an admin knob edit moves a fresh quote, not a saved one', () => {
    process.env[GATE] = 'true';
    const input = estimateInput({ lawn: lawnService() });
    const saved = generateEstimate(input);
    expect(saved.pricingMetadata.lawnCostPlusListKnobs).toEqual(liveKnobs);
    LAWN_PRICING_V2.costPlusList.listMargin = 0.5;
    const signals = savedFloorReplaySignals({ result: saved });
    expect(signals.lawnCostPlusListKnobs.listMargin).toBe(0.45);
    expect(lawnLine(generateEstimate({ ...input, ...signals })).annual).toBe(693);
    const fresh = lawnLine(generateEstimate(input)).annual;
    expect(fresh).toBeGreaterThan(693);
  });

  test('an ON stamp with no snapshot falls back to the live knobs; a bad snapshot fails closed', () => {
    const input = estimateInput({ lawn: lawnService() });
    expect(lawnLine(generateEstimate({ ...input, lawnCostPlusList: true })).annual).toBe(693);
    expect(() => generateEstimate({ ...input, lawnCostPlusList: true, lawnCostPlusListKnobs: { listMargin: 5 } }))
      .toThrow(/cost-plus list pricing knobs are invalid/);
  });

  test('knobs are not stamped when the mode is off', () => {
    const off = generateEstimate(estimateInput({ lawn: lawnService() }));
    expect(off.pricingMetadata).not.toHaveProperty('lawnCostPlusListKnobs');
  });
});

describe('a posted value never beats the gate', () => {
  const posted = (flag) => sanitizeClientIdentityFields({
    ...estimateInput({ lawn: lawnService({ costPlusList: flag }) }),
    lawnCostPlusList: flag,
    lawnCostPlusListKnobs: { listMargin: 0.5 },
  });

  test('gate off + posted true prices market; gate on + posted false prices cost-plus', () => {
    expect(lawnLine(generateEstimate(posted(true))).annual).toBe(576);
    process.env[GATE] = 'true';
    expect(lawnLine(generateEstimate(posted(false))).annual).toBe(693);
  });

  test('the sanitizer strips the top-level and per-service copies without mutating the caller', () => {
    const lawn = { track: 'st_augustine', costPlusList: true };
    const input = { services: { lawn }, lawnCostPlusList: true, lawnCostPlusListKnobs: {} };
    const out = sanitizeClientIdentityFields({ ...input });
    expect(out).toEqual({ services: { lawn: { track: 'st_augustine' } } });
    expect(lawn.costPlusList).toBe(true);
  });

  test('the authoritative recompute drops posted values before replaying', async () => {
    const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
    const seen = [];
    await serverRecomputeFromEstimateData({
      engineInputs: {
        lawnCostPlusList: true,
        services: { lawn: { track: 'st_augustine', costPlusList: true } },
      },
      engineRequest: { options: { lawnCostPlusList: true } },
      result: { lineItems: [{ service: 'lawn_care' }], pricingMetadata: { lawnCostPlusList: false } },
    }, {
      replaySavedPricingKnobs: true,
      needsSync: () => false,
      syncConstantsFromDB: async () => {},
      generateEstimate: (input) => { seen.push(input); return { lineItems: [] }; },
      mapV1ToLegacyShape: () => ({ recurring: { services: [] } }),
      translateV2CallToV1Input: null,
    });
    expect(seen[0].lawnCostPlusList).toBe(false);
    expect(seen[0].services.lawn.costPlusList).toBeUndefined();
  });
});

describe('a lawn added later follows the live gate', () => {
  const replay = (input, saved) => generateEstimate({ ...input, ...savedFloorReplaySignals({ result: saved }) });
  const pestOnly = () => generateEstimate(estimateInput({ pest: { frequency: 'quarterly' } }));
  const withLawn = () => estimateInput({ pest: { frequency: 'quarterly' }, lawn: lawnService() });

  test('saved pest-only estimate (no stamp), gate on, lawn added: cost-plus', () => {
    const saved = pestOnly();
    delete saved.pricingMetadata.lawnCostPlusList;
    process.env[GATE] = 'true';
    expect(lawnLine(replay(withLawn(), saved)).annual).toBe(693);
  });

  test('saved pest-only estimate stamped OFF, gate on, lawn added: cost-plus', () => {
    const saved = pestOnly();
    expect(saved.pricingMetadata.lawnCostPlusList).toBe(false);
    process.env[GATE] = 'true';
    expect(lawnLine(replay(withLawn(), saved)).annual).toBe(693);
  });

  test('saved market-priced lawn with no stamp stays market with the gate on', () => {
    const saved = generateEstimate(withLawn());
    delete saved.pricingMetadata.lawnCostPlusList;
    process.env[GATE] = 'true';
    expect(lawnLine(replay(withLawn(), saved)).annual).toBe(576);
  });

  test('the add-service draft pins the saved lawn mode', () => {
    const { savedLawnCostPlusSignal } = require('../services/estimate-floor-signal-replay');
    const saved = generateEstimate(withLawn());
    process.env[GATE] = 'true';
    const draft = generateEstimate({ ...withLawn(), ...savedLawnCostPlusSignal({ result: saved }) });
    expect(lawnLine(draft).annual).toBe(576);
  });
});

describe('admin write boundary validates costPlusList on its own', () => {
  const good = () => JSON.parse(JSON.stringify(constants.LAWN_COST_PLUS_LIST_DEFAULTS));
  const check = (data) => validatePricingConfigData('lawn_pricing_v2', data, {});

  test('accepts the defaults, alone or beside bermudaSuppression', () => {
    expect(check({ costPlusList: good() }).ok).toBe(true);
    expect(check({ costPlusList: good(), bermudaSuppression: { perAppBase: 15, perAppPer1000Sqft: 2 } }).ok).toBe(true);
    expect(check({ targetCollectedMarginFloor: 0.35 }).ok).toBe(true);
  });

  const bad = {
    'not an object': () => 'nope',
    'an array': () => [],
    'listMargin 0.95': (c) => { c.listMargin = 0.95; return c; },
    'listMargin a string': (c) => { c.listMargin = '0.45'; return c; },
    'minimumPerVisit negative': (c) => { c.minimumPerVisit = -5; return c; },
    'spotMinutesPerVisit NaN-ish': (c) => { c.spotMinutesPerVisit = null; return c; },
    'a cadence missing': (c) => { delete c.materialPer1000SqftPerYear[12]; return c; },
    'a cadence zero': (c) => { c.materialPer1000SqftPerYear[9] = 0; return c; },
    'an unknown cadence': (c) => { c.materialPer1000SqftPerYear[4] = 10; return c; },
    'an unknown key': (c) => { c.extra = 1; return c; },
  };
  for (const [name, mutate] of Object.entries(bad)) {
    test(`rejects ${name}, even beside a valid bermudaSuppression`, () => {
      const costPlusList = mutate(good());
      for (const siblings of [{}, { bermudaSuppression: { perAppBase: 15, perAppPer1000Sqft: 2 } }]) {
        const verdict = check({ ...siblings, costPlusList });
        expect(verdict.ok).toBe(false);
        expect(verdict.error).toMatch(/costPlusList/);
      }
    });
  }
});

describe('public ranges rebuild when the gate flips', () => {
  test('the cached lawn range follows GATE_LAWN_COST_PLUS_LIST', () => {
    const lawnRow = (payload) => JSON.stringify(payload.services.find((row) => row.key === 'lawn_care_program'));
    const off = lawnRow(computePublicPricingRanges());
    process.env[GATE] = 'true';
    const on = lawnRow(computePublicPricingRanges());
    expect(on).not.toBe(off);
    delete process.env[GATE];
    expect(lawnRow(computePublicPricingRanges())).toBe(off);
  });
});

describe('invalid knobs fail closed under an ON mode', () => {
  let saved;
  beforeEach(() => { saved = JSON.parse(JSON.stringify(LAWN_PRICING_V2.costPlusList)); });
  afterEach(() => { LAWN_PRICING_V2.costPlusList = saved; });

  const bad = {
    'listMargin of 0.95': (cfg) => { cfg.listMargin = 0.95; },
    'listMargin of 0': (cfg) => { cfg.listMargin = 0; },
    'listMargin missing': (cfg) => { delete cfg.listMargin; },
    'minimumPerVisit negative': (cfg) => { cfg.minimumPerVisit = -1; },
    'minimumPerVisit null': (cfg) => { cfg.minimumPerVisit = null; },
    'spotMinutesPerVisit not a number': (cfg) => { cfg.spotMinutesPerVisit = 'abc'; },
    'a cadence material of 0': (cfg) => { cfg.materialPer1000SqftPerYear[9] = 0; },
    'a cadence material missing': (cfg) => { delete cfg.materialPer1000SqftPerYear[12]; },
  };

  for (const [name, mutate] of Object.entries(bad)) {
    test(`${name}: priceLawnCare throws a failClosed 400, never a market price`, () => {
      mutate(LAWN_PRICING_V2.costPlusList);
      let error;
      try { price(4500, ON); } catch (e) { error = e; }
      expect(error).toBeDefined();
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('LAWN_COST_PLUS_LIST_KNOBS_INVALID');
      expect(error.failClosed).toBe(true);
    });
  }

  test('the same bad knobs do nothing while the mode is off', () => {
    LAWN_PRICING_V2.costPlusList.listMargin = 0.95;
    expect(byVisits(price(4500, OFF))[9].annual).toBe(576);
  });

  test('generateEstimate surfaces the failure instead of pricing market', () => {
    LAWN_PRICING_V2.costPlusList.listMargin = 7;
    expect(() => generateEstimate(estimateInput({ lawn: lawnService({ costPlusList: true }) })))
      .toThrow(/cost-plus list pricing knobs are invalid/);
  });
});

describe('db-bridge rebases the knobs every sync', () => {
  const { syncConstantsFromDB } = require('../services/pricing-engine/db-bridge');

  function fakeDb(lawnRow) {
    const rows = lawnRow ? [{ config_key: 'lawn_pricing_v2', data: lawnRow }] : [{ config_key: 'global_labor_rate', data: { value: 35 } }];
    const db = (table) => ({
      select: async () => (table === 'pricing_config' ? rows : []),
    });
    db.schema = { hasTable: async (table) => table === 'pricing_config' };
    return db;
  }

  let snapshot;
  beforeEach(() => { snapshot = JSON.parse(JSON.stringify(LAWN_PRICING_V2.costPlusList)); });
  afterEach(() => { LAWN_PRICING_V2.costPlusList = snapshot; });

  test('a row without the key leaves the in-code defaults; a row with it overrides; dropping it restores', async () => {
    await syncConstantsFromDB(fakeDb(null));
    expect(LAWN_PRICING_V2.costPlusList).toEqual(constants.LAWN_COST_PLUS_LIST_DEFAULTS);

    await syncConstantsFromDB(fakeDb({ costPlusList: { listMargin: 0.5, materialPer1000SqftPerYear: { 9: 30 } } }));
    expect(LAWN_PRICING_V2.costPlusList.listMargin).toBe(0.5);
    expect(LAWN_PRICING_V2.costPlusList.materialPer1000SqftPerYear).toEqual({ 6: 16.33, 9: 30, 12: 29.84 });
    expect(LAWN_PRICING_V2.costPlusList.minimumPerVisit).toBe(55);

    await syncConstantsFromDB(fakeDb({ targetCollectedMarginFloor: 0.35 }));
    expect(LAWN_PRICING_V2.costPlusList).toEqual(constants.LAWN_COST_PLUS_LIST_DEFAULTS);
  });
});
