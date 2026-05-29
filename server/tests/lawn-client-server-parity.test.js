/**
 * Client/server lawn-pricing parity.
 *
 * The customer-facing calculator and tech preview run the client engine
 * (client/src/lib/estimateEngine.js) entirely client-side, while the saved/
 * billed price is the server-authoritative recompute (Decision #2, PR #1328).
 * This test pins the client cost floor to the server's so the two never drift —
 * the divergences it guards (and that the parity fix closed) are:
 *   1. material size-scaling clamp [0.6,2.5]  (client used to clamp; server doesn't)
 *   2. shade material variants (St. Augustine)
 *   3. complexity-minutes (heavy shrubs / moderate-complex landscape / large driveway)
 *   4. callback reserve (poor maintenance / high pest pressure)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { priceLawnCare } = require('../services/pricing-engine');

const clientEstimatorPath = path.resolve(__dirname, '../../client/src/lib/estimateEngine.js');

function loadClientEstimator() {
  const source = fs.readFileSync(clientEstimatorPath, 'utf8').replace(/\bexport\s+function\s+/g, 'function ');
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, console };
  vm.createContext(sandbox);
  new vm.Script(
    `${source}\nmodule.exports = { calculateEstimate, calcLawnFloorPrice, lawnComplexityMinutes };`,
    { filename: clientEstimatorPath },
  ).runInContext(sandbox);
  return module.exports;
}

const client = loadClientEstimator();

// Server's selected-tier price for a given turf/track/freq (+ optional property).
function serverTier(sf, track, visits, { property = {} } = {}) {
  const result = priceLawnCare(
    { turfSf: sf, ...property },
    { track, lawnFreq: visits, useLawnCostFloor: true },
  );
  const tier = result.tiers.find((t) => t.freq === visits);
  if (!tier) throw new Error(`no server tier for visits=${visits}`);
  return { pa: tier.perApp, ann: tier.annual, mo: tier.monthly };
}

const TRACKS = ['st_augustine', 'bermuda', 'zoysia', 'bahia'];
const SQFT = [2500, 3000, 4250, 6000, 8000, 12000, 18000, 22000]; // 2500/18000/22000 are outside the old clamp
const VISITS = [6, 9, 12];

describe('client/server lawn parity — base grid (clamp removal)', () => {
  const cases = [];
  for (const track of TRACKS) for (const sf of SQFT) for (const v of VISITS) cases.push([`${track}/${sf}/${v}`, track, sf, v]);

  it.each(cases)('%s', (_label, track, sf, v) => {
    const c = client.calcLawnFloorPrice(sf, track, v);
    const s = serverTier(sf, track, v);
    expect({ pa: c.pa, ann: c.ann, mo: c.mo }).toEqual(s);
  });

  it('the removed clamp actually mattered: 2500 sqft no longer floors material at 0.6×', () => {
    // 2500/4500 = 0.556 — under the old 0.6 clamp, so client used to over-price here.
    const c = client.calcLawnFloorPrice(2500, 'st_augustine', 9);
    const s = serverTier(2500, 'st_augustine', 9);
    expect(c.pa).toBe(s.pa);
  });
});

describe('client/server lawn parity — complexity minutes', () => {
  const combos = [
    { landscapeComplexity: 'MODERATE', shrubDensity: 'LIGHT', hasLargeDriveway: false },
    { landscapeComplexity: 'COMPLEX', shrubDensity: 'LIGHT', hasLargeDriveway: false },
    { landscapeComplexity: 'SIMPLE', shrubDensity: 'HEAVY', hasLargeDriveway: false },
    { landscapeComplexity: 'COMPLEX', shrubDensity: 'HEAVY', hasLargeDriveway: true },
  ];
  it.each(combos.map((c) => [JSON.stringify(c), c]))('%s', (_l, combo) => {
    const minutes = client.lawnComplexityMinutes(combo);
    const c = client.calcLawnFloorPrice(4250, 'st_augustine', 9, { complexityMinutes: minutes });
    const s = serverTier(4250, 'st_augustine', 9, {
      property: {
        landscapeComplexity: combo.landscapeComplexity,
        shrubDensity: combo.shrubDensity,
        features: { largeDriveway: combo.hasLargeDriveway },
      },
    });
    expect({ pa: c.pa, ann: c.ann, mo: c.mo }).toEqual(s);
  });
});

describe('client/server lawn parity — callback reserve (maintenance / pressure)', () => {
  function reserveFor(maintenance, pressure) {
    return 2 +
      (['POOR', 'DEFERRED'].includes(maintenance) ? 5 : 0) +
      (['HIGH', 'SEVERE', 'VERY_HIGH'].includes(pressure) ? 5 : 0);
  }
  const combos = [
    { maintenanceCondition: 'POOR', overallPestPressure: 'NONE' },
    { maintenanceCondition: 'GOOD', overallPestPressure: 'HIGH' },
    { maintenanceCondition: 'DEFERRED', overallPestPressure: 'SEVERE' },
  ];
  it.each(combos.map((c) => [JSON.stringify(c), c]))('%s', (_l, combo) => {
    const reserve = reserveFor(combo.maintenanceCondition, combo.overallPestPressure);
    const c = client.calcLawnFloorPrice(4250, 'st_augustine', 9, { callbackReservePerVisit: reserve });
    const s = serverTier(4250, 'st_augustine', 9, { property: combo });
    expect({ pa: c.pa, ann: c.ann, mo: c.mo }).toEqual(s);
  });
});

describe('client/server lawn parity — full calculateEstimate integration', () => {
  function clientLawnTier(inputs, visits) {
    const est = client.calculateEstimate(inputs);
    expect(est.error).toBeUndefined();
    const tier = est.results.lawn.find((t) => t.v === visits);
    expect(tier).toBeDefined();
    return { pa: tier.pa, ann: tier.ann, mo: tier.mo };
  }

  it('baseline (no complexity) 8000 sqft matches server', () => {
    const c = clientLawnTier({
      homeSqFt: 2000, stories: 1, lotSqFt: 12000, propertyType: 'single_family',
      measuredTurfSf: 8000, svcLawn: true, lawnFreq: 9, grassType: 'st_augustine',
      urgency: 'NONE', isAfterHours: false, isRecurringCustomer: false,
    }, 9);
    expect(c).toEqual(serverTier(8000, 'st_augustine', 9));
  });

  it('complexity flows end-to-end: HEAVY shrubs + COMPLEX + driveway at 2500 sqft matches server', () => {
    const c = clientLawnTier({
      homeSqFt: 2000, stories: 1, lotSqFt: 10000, propertyType: 'single_family',
      measuredTurfSf: 2500, svcLawn: true, lawnFreq: 9, grassType: 'st_augustine',
      shrubDensity: 'HEAVY', landscapeComplexity: 'COMPLEX', hasLargeDriveway: true,
      urgency: 'NONE', isAfterHours: false, isRecurringCustomer: false,
    }, 9);
    const s = serverTier(2500, 'st_augustine', 9, {
      property: { shrubDensity: 'HEAVY', landscapeComplexity: 'COMPLEX', features: { largeDriveway: true } },
    });
    expect(c).toEqual(s);
  });
});
