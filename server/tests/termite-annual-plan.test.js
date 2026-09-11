/**
 * Waves Subterranean Termite Protection — the annual plan (plan §A2/§A3;
 * RULING A-1 = shape P1, owner 2026-09-11). Dark behind
 * GATE_TERMITE_ANNUAL_PLAN: the engine emits a station SETUP fee (one-time,
 * stations × $30, never tier-discounted) + an ANNUAL protection fee ($249
 * base + $50 per 5-station bracket above 10, tier-discounted, 1 visit/yr)
 * instead of today's install + quarterly monitoring; rental and the bond
 * rider are retired on the plan; the plan's own constants replay.
 */
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/pricing-engine', () => {
  const actual = jest.requireActual('../services/pricing-engine');
  return { ...actual, needsSync: () => false };
});
const constants = require('../services/pricing-engine/constants');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { termiteAnnualPlanFeeForStations } = require('../services/pricing-engine/service-pricing');
const { syncConstantsFromDB } = require('../services/pricing-engine/db-bridge');
const adminPricingConfigRouter = require('../routes/admin-pricing-config');
const { validatePricingConfigData } = adminPricingConfigRouter;
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
const replay = require('../services/estimate-tree-shrub-knob-replay');

const HOME = (homeSqFt, extra = {}) => ({ homeSqFt, lotSqFt: 8000, propertyType: 'single_family', ...extra });
const termiteLine = (r) => r.lineItems.find((l) => l.service === 'termite_bait');
const snapshot = JSON.parse(JSON.stringify(constants.TERMITE.annualPlan));
afterEach(() => { Object.assign(constants.TERMITE.annualPlan, JSON.parse(JSON.stringify(snapshot))); });

describe('annual plan — gate', () => {
  test('gate OFF: a plan request prices as today\'s quarterly program (install + 4 station checks)', () => {
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    const li = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } })));
    expect(li.plan).toBe('quarterly');
    expect(li.installation).toMatchObject({ kind: 'install', price: 653 });
    expect(li.visitsPerYear).toBe(4);
    expect(li.annual).toBe(288);
    expect(li.setup).toBeUndefined();
  });
});

describe('annual plan — pricing (ruling A-1 = P1)', () => {
  beforeAll(() => { process.env.GATE_TERMITE_ANNUAL_PLAN = 'true'; });
  afterAll(() => { delete process.env.GATE_TERMITE_ANNUAL_PLAN; });

  test('the bracket ladder: ≤10 → $249, 11-15 → $299, 16-20 → $349, 21-25 → $399', () => {
    expect(termiteAnnualPlanFeeForStations(8)).toBe(249);
    expect(termiteAnnualPlanFeeForStations(10)).toBe(249);
    expect(termiteAnnualPlanFeeForStations(11)).toBe(299);
    expect(termiteAnnualPlanFeeForStations(15)).toBe(299);
    expect(termiteAnnualPlanFeeForStations(16)).toBe(349);
    expect(termiteAnnualPlanFeeForStations(20)).toBe(349);
    expect(termiteAnnualPlanFeeForStations(21)).toBe(399);
  });

  test('2,000 sf (15 stations): $450 setup + $299/yr, one visit; 2,117 sf (16 stations): $480 + $349', () => {
    const a = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } })));
    expect(a).toMatchObject({ plan: 'annual_protection', stations: 15, visitsPerYear: 1, annual: 299, perApp: 299, annualFee: 299, stationsOwnedBy: 'waves', ownership: 'plan' });
    expect(a.installation).toMatchObject({ kind: 'setup', price: 450, retailValue: 653 });
    expect(a.setup).toEqual({ price: 450, perStation: 30, stations: 15, tierDiscountable: false });
    // installation.margin is the margin on what is BILLED — the setup fee's accepted ≈ −10 % (450 vs ≈ 493.58 cost),
    // while retailMargin keeps the outright-install formula's figure for reference.
    expect(a.installation.margin).toBeCloseTo((450 - 493.58) / 450, 2);
    expect(a.installation.retailMargin).toBeGreaterThan(0);
    expect(a.monitoring).toMatchObject({ annual: 299, model: 'annual_protection' });
    expect(a.planTerms).toMatchObject({ coverageMonths: 12, visitsPerYear: 1, retreatOnly: true, subterraneanOnly: true, renewal: 'annual' });
    const b = termiteLine(generateEstimate(HOME(2117, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } })));
    expect(b).toMatchObject({ stations: 16, annual: 349, perApp: 349 });
    expect(b.installation.price).toBe(480);
  });

  test('rental and the bond rider are retired on the plan even when requested', () => {
    process.env.GATE_TERMITE_STATION_RENTAL = 'true';
    process.env.GATE_TERMITE_BOND_OPTION = 'true';
    try {
      const r = generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection', ownership: 'rent', bondTerm: '5yr' } } }));
      expect(r.lineItems.map((l) => l.service)).toEqual(['termite_bait']);
      const li = termiteLine(r);
      expect(li.installation.price).toBe(450);
      expect(li.stationRental).toBeUndefined();
      expect(li.bondOptions).toBeUndefined();
    } finally {
      delete process.env.GATE_TERMITE_STATION_RENTAL;
      delete process.env.GATE_TERMITE_BOND_OPTION;
    }
  });

  test('the plan is Trelona-only: a legacy Advance request is priced as Trelona at 15-ft spacing', () => {
    const li = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'advance', plan: 'annual_protection' } } })));
    expect(li.system).toBe('trelona');
    expect(li.stations).toBe(15); // 224 LF / 15 ft, not 23 at Advance's 10 ft
    expect(li.installation.price).toBe(450);
    expect(li.annual).toBe(299);
  });

  test('the cost model runs on one service visit a year', () => {
    const li = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } })));
    expect(li.costs.serviceVisitsPerYear).toBe(1);
    expect(li.costs.serviceLaborAnnual).toBe(li.costs.serviceLaborPerVisit);
    expect(li.costs.cartridgeReplacementAnnual).toBe(67.62);
  });

  test('the WaveGuard tier discounts the annual fee, never the setup fee', () => {
    const r = generateEstimate(HOME(2000, {
      services: { pest: { frequency: 'quarterly' }, termite: { system: 'trelona', plan: 'annual_protection' } },
    }));
    const li = termiteLine(r);
    expect(r.waveGuard.tier).toBe('silver'); // pest + termite = two qualifying services
    expect(li.installation.price).toBe(450); // setup untouched by the tier
    expect(li.annual).toBe(299);
    expect(li.annualAfterDiscount).toBeCloseTo(299 * 0.9, 2);
    const m = mapV1ToLegacyShape(r);
    expect(m.oneTime.items.find((i) => i.service === 'termite_bait_installation').price).toBe(450);
  });

  test('the mapped admin envelope carries the plan; the one-time item is the Station Setup', () => {
    const m = mapV1ToLegacyShape(generateEstimate(HOME(2117, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } })));
    expect(m.results.tmBait).toMatchObject({ plan: 'annual_protection', setupFee: 480, setupPerStation: 30, annualFee: 349, visitsPerYear: 1 });
    expect(m.oneTime.items).toEqual([expect.objectContaining({ service: 'termite_bait_installation', name: 'Station Setup', price: 480, kind: 'setup', tierDiscountable: false })]);
    expect(m.recurring.services.find((s) => s.service === 'termite_bait')).toMatchObject({ perTreatment: 349, visitsPerYear: 1 });
    expect(m.oneTime.tmInstall).toBe(480);
  });

  test('the V2 translator carries termitePlan; anything else is ignored', () => {
    const on = translateV2CallToV1Input({ homeSqFt: 2000, lotSqFt: 8000 }, ['TERMITE_BAIT'], { termitePlan: 'annual_protection' });
    expect(on.services.termite.plan).toBe('annual_protection');
    const off = translateV2CallToV1Input({ homeSqFt: 2000, lotSqFt: 8000 }, ['TERMITE_BAIT'], { termitePlan: 'quarterly' });
    expect(off.services.termite.plan).toBeUndefined();
  });

  test('the plan constants replay: a config move after send does not change a sent quote', () => {
    const sent = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } })));
    expect(sent.pricingKnobs).toMatchObject({ plan: 'annual_protection', setupPerStation: 30, annualBase: 249, annualStep: 50, bracketStations: 5, bracketFloor: 10 });
    constants.TERMITE.annualPlan.setupPerStation = 35;
    constants.TERMITE.annualPlan.annualBase = 279;
    const live = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } })));
    expect(live.installation.price).toBe(525);
    expect(live.annual).toBe(329);
    const signal = replay.termiteKnobSignalForReplay({ result: { lineItems: [sent] } });
    expect(signal).toMatchObject({ plan: 'annual_protection', setupPerStation: 30, annualBase: 249 });
    const replayed = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } }, termitePricingKnobs: signal })));
    expect(replayed.installation.price).toBe(450);
    expect(replayed.annual).toBe(299);
  });
});

describe('annual plan — an issued plan survives the gate being unset (codex r2 P0)', () => {
  test('gate OFF + a stamped plan snapshot on the replay input keeps pricing the plan with its stamped constants', () => {
    process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
    const sent = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } })));
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    const signal = replay.termiteKnobSignalForReplay({ result: { lineItems: [sent] } });
    const replayed = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } }, termitePricingKnobs: signal })));
    expect(replayed.plan).toBe('annual_protection');
    expect(replayed.installation).toMatchObject({ kind: 'setup', price: 450 });
    expect(replayed).toMatchObject({ visitsPerYear: 1, annual: 299 });
    // …while a FRESH selection with the gate off is still ignored.
    const fresh = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } })));
    expect(fresh.plan).toBe('quarterly');
  });
});

describe('annual plan — DB overlay and admin validation', () => {
  function planDb(data) {
    const db = (table) => {
      const query = {
        select: jest.fn(async () => (table === 'pricing_config' ? [{ config_key: 'termite_annual_plan', data }] : [])),
        orderBy: jest.fn(() => query),
        then: (resolve) => resolve([]),
      };
      return query;
    };
    db.schema = { hasTable: jest.fn(async () => true) };
    return db;
  }

  test('pricing_config.termite_annual_plan overlays the constants and a removed key falls back', async () => {
    await expect(syncConstantsFromDB(planDb({ setup_per_station: 35, annual_base: 279, annual_step: 60, bracket_stations: 4, bracket_floor: 8 }))).resolves.toBe(true);
    expect(constants.TERMITE.annualPlan).toMatchObject({ setupPerStation: 35, annualBase: 279, annualStep: 60, bracketStations: 4, bracketFloor: 8 });
    expect(termiteAnnualPlanFeeForStations(16)).toBe(279 + 2 * 60);
    await expect(syncConstantsFromDB(planDb({ annual_base: 259 }))).resolves.toBe(true);
    expect(constants.TERMITE.annualPlan).toMatchObject({ setupPerStation: 30, annualBase: 259, annualStep: 50, bracketStations: 5, bracketFloor: 10 });
  });

  test('pricing_config.termite_annual_plan accepts a zero step (flat annual fee) and refuses a negative one', async () => {
    await expect(syncConstantsFromDB(planDb({ annual_step: 0 }))).resolves.toBe(true);
    expect(constants.TERMITE.annualPlan.annualStep).toBe(0);
    expect(termiteAnnualPlanFeeForStations(25)).toBe(249);
    await expect(syncConstantsFromDB(planDb({ annual_step: -5 }))).resolves.toBe(true);
    expect(constants.TERMITE.annualPlan.annualStep).toBe(50);
  });

  test('the save path normalizes camelCase aliases to one snake_case spelling', () => {
    const { normalizeIncomingConfigData } = require('../routes/admin-pricing-config');
    expect(normalizeIncomingConfigData('termite_annual_plan', { setupPerStation: 35, annual_base: 259, annualStep: 60 }))
      .toEqual({ setup_per_station: 35, annual_base: 259, annual_step: 60 });
  });

  test('admin validation bounds the plan knobs', () => {
    expect(validatePricingConfigData('termite_annual_plan', { setup_per_station: 30, annual_base: 249, annual_step: 50, bracket_stations: 5, bracket_floor: 10 }, null)).toEqual({ ok: true });
    for (const [patch, key] of [
      [{ setup_per_station: 0 }, 'setup_per_station'],
      [{ setup_per_station: 30.5 }, 'setup_per_station'],
      [{ annual_base: 2490 }, 'annual_base'],
      [{ annual_step: -1 }, 'annual_step'],
      [{ bracket_stations: 0 }, 'bracket_stations'],
      [{ bracketFloor: 101 }, 'bracketFloor'],
    ]) {
      const verdict = validatePricingConfigData('termite_annual_plan', { setup_per_station: 30, annual_base: 249, ...patch }, null);
      expect(verdict.ok).toBe(false);
      expect(verdict.error).toContain(`termite_annual_plan.${key}`);
    }
  });
});

describe('replay-stamp provenance (pre-push audit #4424)', () => {
  test('the admin pricing sandbox strips a posted termitePricingKnobs stamp — gate off prices the quarterly program', async () => {
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    const handler = adminPricingConfigRouter.stack
      .find((layer) => layer.route?.path === '/estimate' && layer.route.methods.post).route.stack[0].handle;
    const body = {
      homeSqFt: 2400, lotSqFt: 9000,
      termitePricingKnobs: { plan: 'annual_protection', stationCost: 24 },
      services: { termite: { plan: 'annual_protection' } },
    };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await handler({ body }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledTimes(1);
    const { estimate } = res.json.mock.calls[0][0];
    // The posted body itself is left alone (a copy is sanitized).
    expect(body.termitePricingKnobs).toEqual({ plan: 'annual_protection', stationCost: 24 });
    const termite = (estimate.lineItems || []).find((l) => l.service === 'termite_bait');
    expect(termite).toBeTruthy();
    expect(termite.plan).toBe('quarterly');
    expect(termite.setupFee).toBeUndefined();
    expect(termite.pricingKnobs.plan).not.toBe('annual_protection');
  });
});
