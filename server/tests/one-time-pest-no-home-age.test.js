/**
 * Owner ruling 2026-11-26: an older home and a newer home pay the same
 * one-time pest price (GATE_ONE_TIME_PEST_NO_HOME_AGE, dark).
 * Behavior: with the gate on, the pest plan keeps its home-age adjustment and
 * the one-time price loses it, on the engine line priced beside a plan and on
 * the one-time choice the estimate page derives from the plan.
 * Regressions it guards: a price move with the gate off, a saved estimate
 * re-priced as sold changing rule when the gate flips either way, and a
 * posted replay stamp being trusted.
 */
const { buildEngineInput } = require('../services/estimator-engine/draft-builder');
const { SQFT_SOURCES } = require('../services/estimator-engine/source-arbitration');
const { generateEstimate } = require('../services/pricing-engine');
const { PEST } = require('../services/pricing-engine/constants');
const {
  quarterlyPerAppWithoutHomeAge, oneTimePestNoHomeAgeReplaySignal, storedPestAgeAdj,
} = require('../services/pricing-engine/one-time-pest-home-age');
const { CLIENT_IDENTITY_FIELDS } = require('../services/estimate-client-identity-fields');
const { oneTimeChoiceAmountForEstimate } = require('../routes/estimate-public');

const GATE = 'GATE_ONE_TIME_PEST_NO_HOME_AGE';
const facts = {
  home: { value: 1800, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] },
  lot: { value: 8000, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] },
  newConstruction: false, tenant: false,
};
const inputFor = (services, yearBuilt, extra = {}) => ({
  ...buildEngineInput({
    intent: {
      decision: 'draft', category: 'RESIDENTIAL', is_commercial: false, address: '101 Example St, Bradenton, FL 34208',
      services, evidence: [], constraint_flags: [], uncertainties: [], confidence: 'high',
    },
    propertyFacts: facts,
    context: {},
  }),
  yearBuilt,
  recurringCustomer: false,
  ...extra,
});
const BOTH = { pest: { frequency: 'quarterly' }, oneTimePest: {} };
const PLAN = { pest: { frequency: 'quarterly' } };
const NEWER = new Date().getFullYear() - 5;
const OLDER = new Date().getFullYear() - 65;
const line = (result, service) => result.lineItems.find((l) => l.service === service);
const pageChoice = (yearBuilt) => {
  const engineInputs = inputFor(PLAN, yearBuilt);
  return oneTimeChoiceAmountForEstimate({ show_one_time_option: true }, { engineInputs, engineResult: generateEstimate(engineInputs) });
};

describe('one-time pest price and home age', () => {
  const before = process.env[GATE];
  afterEach(() => {
    if (before === undefined) delete process.env[GATE];
    else process.env[GATE] = before;
  });

  test('gate off: the older home pays more for the one-time job, as before', () => {
    delete process.env[GATE];
    const newer = generateEstimate(inputFor(BOTH, NEWER));
    const older = generateEstimate(inputFor(BOTH, OLDER));
    expect(line(older, 'pest_control').pestAgeAdj).toBeGreaterThan(0);
    expect(line(older, 'one_time_pest').price).toBeGreaterThan(line(newer, 'one_time_pest').price);
    expect(line(older, 'one_time_pest').homeAgeExcluded).toBeUndefined();
    expect(pageChoice(OLDER)).toBeGreaterThan(pageChoice(NEWER));
  });

  test('gate on: both homes pay the same one-time price and the plan keeps its age adjustment', () => {
    process.env[GATE] = 'true';
    const newer = generateEstimate(inputFor(BOTH, NEWER));
    const older = generateEstimate(inputFor(BOTH, OLDER));
    expect(line(older, 'pest_control').basePrice).toBeGreaterThan(line(newer, 'pest_control').basePrice);
    expect(line(older, 'one_time_pest').price).toBe(line(newer, 'one_time_pest').price);
    expect(line(older, 'one_time_pest').homeAgeExcluded).toBe(true);
    expect(line(newer, 'one_time_pest').homeAgeExcluded).toBeUndefined();
    expect(pageChoice(OLDER)).toBe(pageChoice(NEWER));
    expect(pageChoice(OLDER)).toBe(line(newer, 'one_time_pest').price);
  });

  test('a saved estimate re-priced as sold follows its own stamp, not the gate', () => {
    delete process.env[GATE];
    const soldWithAge = generateEstimate(inputFor(BOTH, OLDER));
    process.env[GATE] = 'true';
    const soldWithoutAge = generateEstimate(inputFor(BOTH, OLDER));
    expect(oneTimePestNoHomeAgeReplaySignal({ engineResult: soldWithAge })).toBe(false);
    expect(oneTimePestNoHomeAgeReplaySignal({ engineResult: soldWithoutAge })).toBe(true);

    // Gate now on, quote sold with the age adjustment: the replay keeps it.
    const replayOld = generateEstimate(inputFor(BOTH, OLDER, { savedEstimateReplay: true }));
    expect(line(replayOld, 'one_time_pest').price).toBe(line(soldWithAge, 'one_time_pest').price);
    // Gate now off, quote sold without it: the replay keeps the lower price.
    delete process.env[GATE];
    const replayNew = generateEstimate(inputFor(BOTH, OLDER, { savedEstimateReplay: true, oneTimePestNoHomeAgeReplay: true }));
    expect(line(replayNew, 'one_time_pest').price).toBe(line(soldWithoutAge, 'one_time_pest').price);
    expect(line(replayNew, 'one_time_pest').homeAgeExcluded).toBe(true);
  });

  test('the replay stamp is server-owned and the helper respects the plan floor', () => {
    expect(CLIENT_IDENTITY_FIELDS).toContain('oneTimePestNoHomeAgeReplay');
    expect(quarterlyPerAppWithoutHomeAge(116, 8)).toBe(108);
    expect(quarterlyPerAppWithoutHomeAge(116, 0)).toBe(116);
    expect(quarterlyPerAppWithoutHomeAge(116, -5)).toBe(116);
    const floor = Number(PEST.floor) > 0 ? Number(PEST.floor) : 0;
    expect(quarterlyPerAppWithoutHomeAge(floor + 3, 8)).toBe(floor);
    expect(storedPestAgeAdj({ result: { lineItems: [{ service: 'pest_control', pestAgeAdj: 5 }] } })).toBe(5);
    expect(storedPestAgeAdj({ result: {} })).toBe(0);
  });
});
