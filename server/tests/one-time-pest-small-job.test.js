/**
 * Owner ruling 2026-11-26 "150 for small one time jobs": a small one-spot
 * one-time pest job is a flat $150 (GATE_ONE_TIME_PEST_SMALL_JOB, dark).
 * Behavior: with the gate on and the staff's smallJob flag, the residential
 * one-time pest line is the flat price; urgency, after-hours and the
 * recurring-customer discount apply, the $199 floor does not. The line is
 * stamped, and a saved estimate replayed as sold follows the stamp, not the gate.
 * Regressions it guards: a price move with the gate off; a roach, commercial or
 * bedroom-band job taking the flat price; a quote changing price when the gate
 * flips; the flat price missing from the pricing config overlay.
 */
const { buildEngineInput } = require('../services/estimator-engine/draft-builder');
const { SQFT_SOURCES } = require('../services/estimator-engine/source-arbitration');
const { generateEstimate } = require('../services/pricing-engine');
const { ONE_TIME } = require('../services/pricing-engine/constants');
const {
  oneTimePestSmallJobReplaySignal, oneTimePestSmallJobBasePrice, smallJobPrice,
} = require('../services/pricing-engine/one-time-pest-small-job');
const { oneTimeChoiceAmountForEstimate, acceptedOneTimeChoiceListForEstimate } = require('../routes/estimate-public');
const { CLIENT_IDENTITY_FIELDS } = require('../services/estimate-client-identity-fields');

const GATE = 'GATE_ONE_TIME_PEST_SMALL_JOB';
const facts = {
  home: { value: 1800, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] },
  lot: { value: 8000, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] },
  newConstruction: false, tenant: false,
};
const inputFor = (oneTimePest, extra = {}, intentExtra = {}) => ({
  ...buildEngineInput({
    intent: {
      decision: 'draft', category: 'RESIDENTIAL', is_commercial: false, address: '101 Example St, Bradenton, FL 34208',
      services: { oneTimePest }, evidence: [], constraint_flags: [], uncertainties: [], confidence: 'high',
      ...intentExtra,
    },
    propertyFacts: facts,
    context: {},
  }),
  yearBuilt: 2015,
  recurringCustomer: false,
  ...extra,
});
const otLine = (result) => result.lineItems.find((l) => l.service === 'one_time_pest');
const SMALL = { smallJob: true };

describe('one-time pest small job', () => {
  const before = process.env[GATE];
  afterEach(() => {
    if (before === undefined) delete process.env[GATE];
    else process.env[GATE] = before;
  });

  test('gate off: the small-job flag changes nothing', () => {
    delete process.env[GATE];
    const plain = otLine(generateEstimate(inputFor({})));
    const flagged = otLine(generateEstimate(inputFor(SMALL)));
    expect(flagged.price).toBe(plain.price);
    expect(plain.price).toBeGreaterThanOrEqual(ONE_TIME.pest.floor);
    expect(flagged.smallJob).toBeUndefined();
  });

  test('gate on: the flag prices the line at the flat price, stamped and labelled; no flag = full price', () => {
    process.env[GATE] = 'true';
    const line = otLine(generateEstimate(inputFor(SMALL)));
    expect(line.price).toBe(150);
    expect(line.smallJob).toBe(true);
    expect(line.name).toMatch(/small job/i);
    // Under the $199 floor, on purpose.
    expect(line.price).toBeLessThan(ONE_TIME.pest.floor);
    expect(otLine(generateEstimate(inputFor({}))).price).toBeGreaterThanOrEqual(ONE_TIME.pest.floor);
  });

  test('urgency, after-hours and the recurring-customer discount apply to the flat price', () => {
    process.env[GATE] = 'true';
    expect(otLine(generateEstimate(inputFor({ ...SMALL, urgency: 'SOON' }))).price).toBe(188); // 150 x 1.25
    expect(otLine(generateEstimate(inputFor({ ...SMALL, urgency: 'SOON', afterHours: true }))).price).toBe(225); // 150 x 1.5
    const member = otLine(generateEstimate(inputFor(SMALL, { recurringCustomer: true })));
    expect(member.price).toBe(128); // 150 x 0.85, rounded
    expect(member.smallJob).toBe(true);
    expect(otLine(generateEstimate(inputFor({ ...SMALL, urgency: 'SOON' }, { recurringCustomer: true }))).price).toBe(159); // 187.5 x 0.85
  });

  test('a roach job and a commercial property never take the flat price', () => {
    process.env[GATE] = 'true';
    const roach = otLine(generateEstimate(inputFor({ ...SMALL, roachType: 'german' })));
    expect(roach.smallJob).toBeUndefined();
    expect(roach.price).toBeGreaterThanOrEqual(ONE_TIME.pest.floor);
    const commercial = generateEstimate(inputFor(SMALL, {}, { category: 'COMMERCIAL', is_commercial: true }));
    expect(commercial.lineItems.some((l) => l.smallJob === true)).toBe(false);
    expect(commercial.lineItems.some((l) => l.price === 150)).toBe(false);
  });

  test('a saved small-job line replays at the flat price with the gate off; an unstamped one never gets it', () => {
    process.env[GATE] = 'true';
    const sold = generateEstimate(inputFor(SMALL));
    expect(oneTimePestSmallJobReplaySignal({ engineResult: sold })).toBe(150);
    delete process.env[GATE];
    const replay = generateEstimate(inputFor(SMALL, { savedEstimateReplay: true, oneTimePestSmallJobReplay: 150 }));
    expect(otLine(replay).price).toBe(150);
    expect(otLine(replay).smallJob).toBe(true);
    // Sold at the full price, gate on later: the replay keeps the full price.
    const soldFull = generateEstimate(inputFor(SMALL));
    expect(oneTimePestSmallJobReplaySignal({ engineResult: soldFull })).toBeNull();
    process.env[GATE] = 'true';
    const replayFull = generateEstimate(inputFor(SMALL, { savedEstimateReplay: true }));
    expect(otLine(replayFull).price).toBe(otLine(soldFull).price);
    expect(otLine(replayFull).smallJob).toBeUndefined();
  });

  test('the replay stamp is server-owned, the price is config-driven, and the decision rules hold', () => {
    expect(CLIENT_IDENTITY_FIELDS).toContain('oneTimePestSmallJobReplay');
    expect(smallJobPrice()).toBe(150);
    const saved = ONE_TIME.pest.smallJobPrice;
    try {
      ONE_TIME.pest.smallJobPrice = 140;
      process.env[GATE] = 'true';
      expect(otLine(generateEstimate(inputFor(SMALL))).price).toBe(140);
      ONE_TIME.pest.smallJobPrice = undefined;
      expect(otLine(generateEstimate(inputFor(SMALL))).smallJob).toBeUndefined();
    } finally {
      ONE_TIME.pest.smallJobPrice = saved;
    }
    process.env[GATE] = 'true';
    expect(oneTimePestSmallJobBasePrice({}, { smallJob: true })).toBe(150);
    expect(oneTimePestSmallJobBasePrice({}, { smallJob: true, roachType: 'german' })).toBeNull();
    expect(oneTimePestSmallJobBasePrice({}, {})).toBeNull();
    // A replay ignores the live flag and gate, and returns the saved price.
    expect(oneTimePestSmallJobBasePrice({ savedEstimateReplay: true }, { smallJob: true })).toBeNull();
    expect(oneTimePestSmallJobBasePrice({ savedEstimateReplay: true, oneTimePestSmallJobReplay: 150 }, {})).toBe(150);
    expect(oneTimePestSmallJobBasePrice({ savedEstimateReplay: true, oneTimePestSmallJobReplay: 150 }, { roachType: 'german' })).toBeNull();
  });

  test('a saved small-job quote keeps its sold flat price when the configured price changes', () => {
    process.env[GATE] = 'true';
    const sold = generateEstimate(inputFor({ ...SMALL, urgency: 'SOON' }));
    expect(otLine(sold).smallJobBasePrice).toBe(150);
    const saved = ONE_TIME.pest.smallJobPrice;
    try {
      ONE_TIME.pest.smallJobPrice = 175;
      const signal = oneTimePestSmallJobReplaySignal({ engineResult: sold });
      expect(signal).toBe(150);
      const replay = generateEstimate(inputFor({ ...SMALL, urgency: 'SOON' }, { savedEstimateReplay: true, oneTimePestSmallJobReplay: signal }));
      expect(otLine(replay).price).toBe(otLine(sold).price);
      expect(otLine(replay).smallJobBasePrice).toBe(150);
      // A live quote today uses the new price.
      expect(otLine(generateEstimate(inputFor(SMALL))).price).toBe(175);
    } finally {
      ONE_TIME.pest.smallJobPrice = saved;
    }
  });

  test('the estimate page one-time choice beside a plan is the small-job line, labelled one spot', () => {
    process.env[GATE] = 'true';
    const withPlan = (oneTimePest) => ({
      ...inputFor(oneTimePest),
      services: { pest: { frequency: 'quarterly' }, oneTimePest },
    });
    const SHOWN = { show_one_time_option: true };
    const small = generateEstimate(withPlan(SMALL));
    const full = generateEstimate(withPlan({}));
    expect(otLine(small).price).toBe(150);
    expect(oneTimeChoiceAmountForEstimate(SHOWN, { engineResult: small })).toBe(150);
    // Same estimate shown with the gate off later: the saved line still decides.
    delete process.env[GATE];
    expect(oneTimeChoiceAmountForEstimate(SHOWN, { engineResult: small })).toBe(150);
    const accepted = acceptedOneTimeChoiceListForEstimate(SHOWN, { engineResult: small });
    expect(accepted[0]).toEqual(expect.objectContaining({ service: 'one_time_pest', price: 150 }));
    expect(accepted[0].label).toMatch(/small job/i);
    // An estimate with the full one-time line is unchanged.
    expect(oneTimeChoiceAmountForEstimate(SHOWN, { engineResult: full })).toBe(otLine(full).price);
    expect(otLine(full).price).toBeGreaterThanOrEqual(ONE_TIME.pest.floor);
  });
});
