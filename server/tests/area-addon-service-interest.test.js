// Codex round 17 on #6135: an add-on-only estimate from the admin estimator saved with service_interest null and line
// `unknown` (the save payload carries inputs.areaAddOns and no svc* flag, and the recurring rows are empty), so the estimate
// emails rendered an empty "Service" row and the dashboard / engagement segmentation lost the family. The CENTRAL
// inference (estimate-service-lines.js) now reads the add-ons: their family from the add-on's own category, their name
// for the summary. A recurring plan keeps its own interest and lines.

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { inferEstimateServiceInterest, inferEstimateServiceLines } = require('../services/estimate-service-lines');
const { followupEmailVars } = require('../services/estimate-followup-copy');

const FIRE_ANT = { service: 'area_addon', addOnKey: 'fire_ant_yard', name: 'Fire Ant Yard Treatment', price: 120, priceAfterDiscount: 120 };
const WEB_SWEEP = { service: 'area_addon', addOnKey: 'web_sweep', name: 'Web Sweep', price: 95 };
const SPOT = { service: 'area_addon', addOnKey: 'lawn_insect_spot', name: 'Lawn Insect Spot Treatment', price: 140 };
const resultWith = (...rows) => ({ oneTime: { items: rows }, lineItems: rows });
// What the admin estimator saves for an add-on-only estimate: the form map under inputs, no svc* flag.
const addOnOnly = (...rows) => ({
  inputs: { areaAddOns: Object.fromEntries(rows.map((row) => [row.addOnKey, { areaSqFt: '4000' }])) },
  result: resultWith(...rows),
});
const keysOf = (estimate) => inferEstimateServiceLines(estimate).map((line) => line.key);

describe('add-on only estimates', () => {
  test('one lawn add-on: the lawn family and its name', () => {
    const estimate = { estimateData: addOnOnly(FIRE_ANT), onetimeTotal: 120 };
    expect(keysOf(estimate)).toEqual(['lawn']);
    expect(inferEstimateServiceInterest(estimate)).toBe('Fire Ant Yard Treatment');
  });

  test('two add-ons of different families: both families, both names (config order)', () => {
    const estimate = { estimateData: addOnOnly(WEB_SWEEP, FIRE_ANT) };
    expect(keysOf(estimate)).toEqual(['lawn', 'pest']);
    expect(inferEstimateServiceInterest(estimate)).toBe('Fire Ant Yard Treatment + Web Sweep');
  });

  test('two add-ons of one family: one family key per estimate segment, two names', () => {
    const estimate = { estimateData: addOnOnly(SPOT, FIRE_ANT) };
    expect([...new Set(keysOf(estimate))]).toEqual(['lawn']);
    expect(inferEstimateServiceInterest(estimate)).toBe('Lawn Insect Spot Treatment + Fire Ant Yard Treatment');
  });

  test('the web sweep alone is pest control, not lawn', () => {
    expect(keysOf({ estimateData: addOnOnly(WEB_SWEEP) })).toEqual(['pest']);
  });

  test('a saved estimate (the stored interest is the add-on name) keeps the lawn family: the name never keys as pest', () => {
    const estimate = { service_interest: 'Fire Ant Yard Treatment', estimate_data: addOnOnly(FIRE_ANT) };
    expect(keysOf(estimate)).toEqual(['lawn']);
    expect(inferEstimateServiceInterest(estimate)).toBe('Fire Ant Yard Treatment');
  });

  test('replayable inputs alone (no stored result yet): the form map, the request list or the engine list', () => {
    for (const data of [
      { inputs: { areaAddOns: { fire_ant_yard: {} } } },
      { engineRequest: { options: { areaAddOns: [{ key: 'fire_ant_yard' }] } } },
      { engineInputs: { services: { areaAddOns: [{ key: 'fire_ant_yard' }] } } },
    ]) {
      expect(inferEstimateServiceInterest({ estimateData: data })).toBe('Fire Ant Yard Treatment');
    }
  });

  test('a stale engineResult add-on the revision removed adds nothing', () => {
    const estimate = { estimateData: { inputs: {}, result: { oneTime: { items: [{ service: 'one_time_pest', name: 'One-Time Pest', price: 150 }] } }, engineResult: resultWith(FIRE_ANT) } };
    expect(keysOf(estimate)).toEqual(['unknown']);
    expect(inferEstimateServiceInterest(estimate)).toBeNull();
  });

  test('an explicit interest still wins', () => {
    expect(inferEstimateServiceInterest({ serviceInterest: 'Yard help', estimateData: addOnOnly(FIRE_ANT) })).toBe('Yard help');
  });

  test('unknown add-on keys and a custom-quote row (no price) are safe', () => {
    expect(keysOf({ estimateData: { inputs: { areaAddOns: { constructor: {} } } } })).toEqual(['unknown']);
    const quoteRequired = { ...FIRE_ANT, price: null, quoteRequired: true };
    expect(inferEstimateServiceInterest({ estimateData: addOnOnly(quoteRequired) })).toBe('Fire Ant Yard Treatment');
  });
});

describe('add-ons beside other services', () => {
  test('add-on + a one-time pest service: the existing line and the add-on both appear', () => {
    const estimate = { estimateData: { inputs: { svcOnetimePest: true, areaAddOns: { fire_ant_yard: {} } }, result: resultWith(FIRE_ANT) } };
    expect(keysOf(estimate)).toEqual(['pest', 'lawn']);
    expect(inferEstimateServiceInterest(estimate)).toBe('Pest Control + Fire Ant Yard Treatment');
  });

  test('add-on + a recurring plan: the plan keeps its interest and its lines (no add-on in the summary)', () => {
    const estimate = {
      estimateData: {
        inputs: { svcPest: true, areaAddOns: { fire_ant_yard: {} } },
        result: { recurring: { services: [{ service: 'pest_control', mo: 45 }] }, oneTime: { items: [FIRE_ANT] }, lineItems: [FIRE_ANT] },
      },
    };
    expect(keysOf(estimate)).toEqual(['pest']);
    expect(inferEstimateServiceInterest(estimate)).toBe('Pest Control');
  });

  test('an estimate with no add-on is unchanged', () => {
    expect(keysOf({ estimateData: { inputs: { svcLawn: true } } })).toEqual(['lawn']);
    expect(inferEstimateServiceInterest({ estimateData: { inputs: {} } })).toBeNull();
  });
});

describe('the save path stores it', () => {
  test('an add-on-only save writes service_interest (it was null)', () => {
    const { buildEstimatePersistenceFields } = require('../services/admin-estimate-persistence');
    const fields = buildEstimatePersistenceFields({
      address: '1 Test Way', customerName: 'Test Person', customerPhone: '(941) 555-0100', customerId: null,
      monthlyTotal: 0, annualTotal: 0, onetimeTotal: 120, tier: null,
      estimateData: addOnOnly(FIRE_ANT),
    }, { technicianId: null, pricingAuthority: 'SERVER' });
    expect(fields.service_interest).toBe('Fire Ant Yard Treatment');
  });
});

describe('customer-facing text this changes', () => {
  const estimate = { service_interest: 'Fire Ant Yard Treatment + Web Sweep', estimate_data: addOnOnly(WEB_SWEEP, FIRE_ANT), onetime_total: 215, monthly_total: 0 };

  test('the summary string (the "Service" row of the estimate and follow-up emails) names the add-ons and shows no price or brand', () => {
    const summary = inferEstimateServiceInterest({ estimateData: estimate.estimate_data });
    expect(summary).toBe('Fire Ant Yard Treatment + Web Sweep');
    expect(summary).not.toMatch(/\$|\d/);
    for (const key of ['bed_pre_emergent', 'lawn_insect_spot', 'fire_ant_yard', 'lawn_insect_preventive', 'hardscape_weed', 'web_sweep']) {
      const name = inferEstimateServiceInterest({ estimateData: { inputs: { areaAddOns: { [key]: {} } } } });
      expect(name).not.toMatch(/Snapshot|Arena|Topchoice|Acelepryn|Roundup|Celsius|Specticle|Talstar/i);
    }
  });

  test('follow-up copy now resolves the one-time pack for an add-on-only estimate, where it was the generic plan pack', () => {
    const vars = followupEmailVars(estimate);
    expect(vars.service_label).toBe('service quote');
    expect(vars.category_headline).toBe('Your service quote is ready');
    expect(vars.category_hook).toBe('One visit, priced from your actual property — not somebody else’s.');
    expect(vars.category_process).toBe('Approve online, pick a time, and your tech completes the treatment — documented so you know exactly what was done.');
  });
});
