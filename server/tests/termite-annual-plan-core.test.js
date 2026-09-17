/** Approved annual-plan pricing and config, without an estimate selection path. */
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
const { TERMITE } = require('../services/pricing-engine/constants');
const { priceTermiteBait, termiteAnnualPlanFeeForStations } = require('../services/pricing-engine/service-pricing');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { syncConstantsFromDB } = require('../services/pricing-engine/db-bridge');
const { validatePricingConfigData, normalizeIncomingConfigData } = require('../routes/admin-pricing-config');
const originalPlan = { ...TERMITE.annualPlan };
afterEach(() => { Object.assign(TERMITE.annualPlan, originalPlan); });

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

test('annual program prices approved setup and annual brackets with one visit', () => {
  const quote = (sqft) => priceTermiteBait({ homeSqFt: sqft, lotSqFt: 8000 }, { system: 'trelona', plan: 'annual_protection' });
  const fifteen = quote(2000);
  expect(fifteen).toMatchObject({ plan: 'annual_protection', stations: 15, annual: 299, perApp: 299, visitsPerYear: 1, ownership: 'plan', stationsOwnedBy: 'waves' });
  expect(fifteen.installation).toMatchObject({ kind: 'setup', price: 450, retailValue: 653 });
  expect(fifteen.setup).toMatchObject({ price: 450, tierDiscountable: false });
  expect(quote(2117)).toMatchObject({ stations: 16, annual: 349, installation: { price: 480 } });
  expect(termiteAnnualPlanFeeForStations(10)).toBe(249);
  expect(termiteAnnualPlanFeeForStations(21)).toBe(399);
});

test('a posted annual option remains quarterly with the gate unset in this pricing-only slice', () => {
  const priorGate = process.env.GATE_TERMITE_ANNUAL_PLAN;
  delete process.env.GATE_TERMITE_ANNUAL_PLAN;
  try {
    const result = generateEstimate({
      homeSqFt: 2000, lotSqFt: 8000, propertyType: 'single_family',
      services: { termite: { system: 'trelona', plan: 'annual_protection' } },
    });
    const line = result.lineItems.find((item) => item.service === 'termite_bait');
    expect(line).toMatchObject({ plan: 'quarterly', visitsPerYear: 4, annual: 288, installation: { kind: 'install', price: 653 } });
  } finally {
    if (priorGate === undefined) delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    else process.env.GATE_TERMITE_ANNUAL_PLAN = priorGate;
  }
});

test('captured annual knobs preserve a priced quote after live config moves', () => {
  const property = { homeSqFt: 2000, lotSqFt: 8000 };
  const before = priceTermiteBait(property, { system: 'trelona', plan: 'annual_protection' });
  Object.assign(TERMITE.annualPlan, { setupPerStation: 35, annualBase: 279, annualStep: 60 });
  const replay = priceTermiteBait(property, { system: 'trelona', plan: 'annual_protection', knobs: before.pricingKnobs });
  expect(replay.installation.price).toBe(before.installation.price);
  expect(replay.annual).toBe(before.annual);
  expect(priceTermiteBait(property, { system: 'trelona', plan: 'annual_protection' }).annual).toBe(339);
});

test('DB overlay resets removed knobs and the admin validator bounds edits', async () => {
  await expect(syncConstantsFromDB(planDb({ setup_per_station: 35, annual_base: 279, annual_step: 60, bracket_stations: 4, bracket_floor: 8 }))).resolves.toBe(true);
  expect(TERMITE.annualPlan).toMatchObject({ setupPerStation: 35, annualBase: 279, annualStep: 60, bracketStations: 4, bracketFloor: 8 });
  await expect(syncConstantsFromDB(planDb({ annual_base: 259 }))).resolves.toBe(true);
  expect(TERMITE.annualPlan).toMatchObject({ setupPerStation: 30, annualBase: 259, annualStep: 50, bracketStations: 5, bracketFloor: 10 });
  expect(normalizeIncomingConfigData('termite_annual_plan', { setupPerStation: 35 })).toEqual({ setup_per_station: 35 });
  expect(validatePricingConfigData('termite_annual_plan', { setup_per_station: 30, annual_base: 249, annual_step: 50, bracket_stations: 5, bracket_floor: 10 }, null)).toEqual({ ok: true });
  expect(validatePricingConfigData('termite_annual_plan', { annual_step: -1 }, null).ok).toBe(false);
  expect(validatePricingConfigData('termite_annual_plan', [], null).ok).toBe(false);
});
