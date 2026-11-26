/**
 * Owner ruling 2026-11-26: an older home and a newer home pay the same
 * one-time pest price (GATE_ONE_TIME_PEST_NO_HOME_AGE, dark).
 * A NEW quote has no home-age step at all, under either gate state (owner "only new estimtes": one-time-pest-price.js, stamp
 * legacyOneTimePestBuffer=false). The gate's behavior below is that of a quote saved BEFORE the rule (legacyOneTimePestBuffer=true):
 * the existing code path, unchanged.
 * Behavior: with the gate on, the engine saves the quarterly rate with no
 * home-age adjustment on the plan line; the one-time line on the same
 * estimate and the estimate page's one-time choice are priced from it. The
 * plan keeps its age adjustment.
 * Regressions it guards: a price move with the gate off; the page amount
 * changing between display and acceptance when the gate flips; a saved
 * estimate re-priced as sold changing rule (also across an age threshold
 * and a floor change); a posted replay stamp being trusted.
 */
const { buildEngineInput } = require('../services/estimator-engine/draft-builder');
const { SQFT_SOURCES } = require('../services/estimator-engine/source-arbitration');
const { generateEstimate } = require('../services/pricing-engine');
const {
  quarterlyPerAppWithoutHomeAge, oneTimePestNoHomeAgeReplaySignal, storedOneTimeAnchorPerApp,
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
const YEAR = new Date().getFullYear();
const NEWER = YEAR - 5;
const OLDER = YEAR - 65;
const line = (result, service) => result.lineItems.find((l) => l.service === service);
// A quote saved before the one-time pest rule (the existing code path): the rule stamp reads legacy.
const LEGACY = { legacyOneTimePestBuffer: true };
const SHOWN = { show_one_time_option: true };
const pageChoice = (engineResult) => oneTimeChoiceAmountForEstimate(SHOWN, { engineResult });

describe('one-time pest price and home age', () => {
  const before = process.env[GATE];
  afterEach(() => {
    if (before === undefined) delete process.env[GATE];
    else process.env[GATE] = before;
  });

  test('a fresh quote is age-independent under both gate states: the plan and the one-time price', () => {
    for (const gate of [undefined, 'true']) {
      if (gate === undefined) delete process.env[GATE]; else process.env[GATE] = gate;
      const newer = generateEstimate(inputFor(BOTH, NEWER));
      const older = generateEstimate(inputFor(BOTH, OLDER));
      expect(line(older, 'pest_control').pestAgeAdj).toBe(0);
      expect(line(older, 'pest_control').basePrice).toBe(line(newer, 'pest_control').basePrice);
      expect(line(older, 'one_time_pest').price).toBe(line(newer, 'one_time_pest').price);
      expect(pageChoice(generateEstimate(inputFor(PLAN, OLDER)))).toBe(pageChoice(generateEstimate(inputFor(PLAN, NEWER))));
      expect(older.pricingMetadata.legacyOneTimePestBuffer).toBe(false);
    }
  });

  test('legacy quote, gate off: the older home pays more for the one-time job, as before, and nothing is stamped', () => {
    delete process.env[GATE];
    const newer = generateEstimate(inputFor(BOTH, NEWER, LEGACY));
    const older = generateEstimate(inputFor(BOTH, OLDER, LEGACY));
    expect(line(older, 'pest_control').pestAgeAdj).toBeGreaterThan(0);
    expect(line(older, 'one_time_pest').price).toBeGreaterThan(line(newer, 'one_time_pest').price);
    expect(line(older, 'pest_control').oneTimeAnchorPerApp).toBeUndefined();
    expect(pageChoice(generateEstimate(inputFor(PLAN, OLDER, LEGACY)))).toBeGreaterThan(pageChoice(generateEstimate(inputFor(PLAN, NEWER, LEGACY))));
  });

  test('legacy quote, gate on: both homes pay the same one-time price and the plan keeps its age adjustment', () => {
    process.env[GATE] = 'true';
    const newer = generateEstimate(inputFor(BOTH, NEWER, LEGACY));
    const older = generateEstimate(inputFor(BOTH, OLDER, LEGACY));
    expect(line(older, 'pest_control').basePrice).toBeGreaterThan(line(newer, 'pest_control').basePrice);
    expect(line(older, 'one_time_pest').price).toBe(line(newer, 'one_time_pest').price);
    expect(line(older, 'pest_control').oneTimeAnchorPerApp).toBe(line(newer, 'pest_control').basePrice);
    // The rule is stamped even when the home has no age adjustment today.
    expect(line(newer, 'pest_control').oneTimeAnchorPerApp).toBe(line(newer, 'pest_control').basePrice);
    // The estimate page's choice beside a plan agrees with the engine's one-time line.
    expect(pageChoice(generateEstimate(inputFor(PLAN, OLDER, LEGACY)))).toBe(line(newer, 'one_time_pest').price);
  });

  test('the page amount of a priced legacy estimate does not move when the gate flips', () => {
    delete process.env[GATE];
    const pricedOff = generateEstimate(inputFor(PLAN, OLDER, LEGACY));
    process.env[GATE] = 'true';
    const pricedOn = generateEstimate(inputFor(PLAN, OLDER, LEGACY));
    const shownOn = pageChoice(pricedOn);
    expect(pageChoice(pricedOff)).toBeGreaterThan(shownOn);
    delete process.env[GATE];
    expect(pageChoice(pricedOn)).toBe(shownOn);
  });

  test('a saved estimate re-priced as sold follows its own stamp, not the gate or the home\'s new age', () => {
    delete process.env[GATE];
    const soldWithAge = generateEstimate(inputFor(BOTH, OLDER, LEGACY));
    process.env[GATE] = 'true';
    const soldWithoutAge = generateEstimate(inputFor(BOTH, NEWER, LEGACY));
    expect(oneTimePestNoHomeAgeReplaySignal({ engineResult: soldWithAge })).toBe(false);
    expect(oneTimePestNoHomeAgeReplaySignal({ engineResult: soldWithoutAge })).toBe(true);

    // Gate now on, quote sold with the age adjustment: the replay keeps it.
    const replayOld = generateEstimate(inputFor(BOTH, OLDER, { ...LEGACY, savedEstimateReplay: true }));
    expect(line(replayOld, 'one_time_pest').price).toBe(line(soldWithAge, 'one_time_pest').price);
    // Gate now off, and the home has since crossed an age threshold: a quote
    // sold on the rule keeps its one-time price.
    delete process.env[GATE];
    const replayNew = generateEstimate(inputFor(BOTH, OLDER, { ...LEGACY, savedEstimateReplay: true, oneTimePestNoHomeAgeReplay: true }));
    expect(line(replayNew, 'one_time_pest').price).toBe(line(soldWithoutAge, 'one_time_pest').price);
    expect(storedOneTimeAnchorPerApp({ engineResult: replayNew })).toBe(line(soldWithoutAge, 'pest_control').basePrice);
  });

  test('the replay stamp is server-owned and the helper uses the floor it is given', () => {
    expect(CLIENT_IDENTITY_FIELDS).toContain('oneTimePestNoHomeAgeReplay');
    expect(quarterlyPerAppWithoutHomeAge(116, 8, 90)).toBe(108);
    expect(quarterlyPerAppWithoutHomeAge(116, 0, 90)).toBe(116);
    expect(quarterlyPerAppWithoutHomeAge(116, -5, 90)).toBe(116);
    // The quote-time floor, not today's: a 112 floor holds the rate at 112.
    expect(quarterlyPerAppWithoutHomeAge(116, 8, 112)).toBe(112);
    expect(storedOneTimeAnchorPerApp({ result: { lineItems: [{ service: 'pest_control', oneTimeAnchorPerApp: 108 }] } })).toBe(108);
    expect(storedOneTimeAnchorPerApp({ result: { lineItems: [{ service: 'pest_control' }] } })).toBeNull();
  });
});
