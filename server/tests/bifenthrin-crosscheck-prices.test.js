/**
 * Owner 2026-11-18: the bifenthrin bottle is LESCO Crosscheck Plus (1 gal = 128 fl oz at $30.90). Constants only (no DB).
 * Pre-slab bifenthrin prices fall as the owner was shown; every price that does not use the bifenthrin bottle stays put.
 */
process.env.NODE_ENV = 'test';

const { pricePreSlabTermiticide, priceTrenching, priceMosquito, pricePestControl } = require('../services/pricing-engine/service-pricing');
const constants = require('../services/pricing-engine/constants');

const SLABS = [3000, 3500, 4500, 6832, 10000, 13500];
const preslab = (sqft, productKey) => pricePreSlabTermiticide({ slabSqFt: sqft }, { productKey }).price;
const trench = (productKey, applicationRate, lf) => priceTrenching({}, {
  productKey, applicationRate, labelConfirmed: true, measurements: { perimeterLF: lf, concreteLF: 0 },
});

describe('LESCO Crosscheck Plus bifenthrin cost', () => {
  test.each(['talstar_p', 'bifen_it'])('pre-slab %s prices drop to the shown figures (before: 510 571 697 993 1246 1532)', (key) => {
    expect(SLABS.map((sqft) => preslab(sqft, key))).toEqual([510, 510, 534, 743, 884, 1044]);
  });

  test('the bottle is 128 fl oz at $30.90, label Crosscheck Plus', () => {
    const result = pricePreSlabTermiticide({ slabSqFt: 4500 }, { productKey: 'talstar_p' });
    expect(result.productLabel).toBe('Crosscheck Plus - Bifenthrin');
    expect(result.containerOz).toBe(128);
    expect(result.containerCost).toBe(30.9);
  });

  test('Crosscheck aliases resolve to the talstar_p option', () => {
    // 'Cross Check Plus' is an inventory alias (migration 20261119010000); the resolvers normalize each spelling first.
    for (const alias of ['crosscheck', 'crosscheck_plus', 'lesco_crosscheck_plus', 'talak', 'atticus_talak', 'Cross Check Plus', 'LESCO Cross Check Plus', 'cross check']) {
      expect(pricePreSlabTermiticide({ slabSqFt: 6832 }, { productKey: alias }).productKey).toBe('talstar_p');
      expect(trench(alias, 'standard', 100).productKey).toBe('talstar_p');
    }
  });

  test('Termidor SC and Taurus SC pre-slab prices are unchanged', () => {
    expect(SLABS.map((sqft) => preslab(sqft, 'termidor_sc'))).toEqual([1278, 1470, 1852, 2764, 3813, 4998]);
    expect(SLABS.map((sqft) => preslab(sqft, 'taurus_sc'))).toEqual([815, 929, 1157, 1698, 2269, 2913]);
  });

  test('trench prices are unchanged for every product; only the bifenthrin chemical cost falls', () => {
    const prices = (key) => ['standard', 'high'].flatMap((rate) => [100, 200, 400].map((lf) => trench(key, rate, lf).price));
    expect(prices('talstar_p')).toEqual([1000, 2000, 4000, 1120, 2240, 4480]);
    expect(prices('bifen_it')).toEqual([1000, 2000, 4000, 1120, 2240, 4480]);
    expect(prices('termidor_sc')).toEqual([1024, 2047, 4095, 1196, 2391, 4783]);
    expect(prices('taurus_sc')).toEqual([1000, 2000, 4000, 1148, 2297, 4593]);
    expect(trench('talstar_p', 'standard', 100).allocatedChemicalCost).toBe(4.83); // was 8.66 at 96 fl oz / $41.57
    // The label's high rate is 0.12% at half the volume: 80 oz for 400 LF, as at the standard rate (was 160 oz, $69.28 at the Talak cost).
    expect(trench('talstar_p', 'high', 400)).toMatchObject({ finishedGallons: 40, productOz: 80, allocatedChemicalCost: 19.31 });
  });

  test('mosquito prices do not move: only cost and margin follow the bifenthrin figure', () => {
    const lots = [6000, 12000, 25000, 50000];
    const run = () => lots.flatMap((lot) => ['seasonal9', 'monthly12'].map((tier) => priceMosquito({ lotSqFt: lot, homeSqFt: 2000 }, { tier })));
    const strip = (r) => JSON.stringify(r, (k, v) => (['costs', 'margin', 'marginFloorOk'].includes(k) ? undefined : v));
    const after = run();
    const original = constants.MOSQUITO.productCosts.bifenthrinOz;
    constants.MOSQUITO.productCosts.bifenthrinOz = 41.57 / 96;
    let before;
    try { before = run(); } finally { constants.MOSQUITO.productCosts.bifenthrinOz = original; }
    expect(after.map(strip)).toEqual(before.map(strip));
    expect(after[0].costs.materialPerVisit).toBeLessThan(before[0].costs.materialPerVisit);
  });

  test('pest control prices do not move: only the per-visit chemical cost and margin follow', () => {
    const quarterly = pricePestControl({ homeSqFt: 2500, lotSqFt: 9000 }, { frequency: 'quarterly' });
    expect([quarterly.perApp, quarterly.annual, quarterly.monthly]).toEqual([115, 460, 38.33]);
    expect(quarterly.costs.materialPerVisit).toBe(6.34); // bifenthrin 0.97 + taurus 4.87 + surfactant 0.50 (was 6.67)
    const monthly = pricePestControl({ homeSqFt: 4000, lotSqFt: 9000 }, { frequency: 'monthly' });
    expect([monthly.perApp, monthly.annual, monthly.monthly]).toEqual([95.16, 1141.92, 95.16]);
    const bimonthly = pricePestControl({ homeSqFt: 1500, lotSqFt: 9000 }, { frequency: 'bimonthly' });
    expect([bimonthly.perApp, bimonthly.annual, bimonthly.monthly]).toEqual([94.16, 564.96, 47.08]);
  });
});
