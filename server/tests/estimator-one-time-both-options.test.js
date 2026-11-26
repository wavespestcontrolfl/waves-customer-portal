/**
 * Owner ruling 2026-11-23: a one-time pest ask shows BOTH options on the
 * estimate (the plan and the one-time price).
 * Behavior: on a call, a one-time-only pest intent gains the quarterly plan
 * before pricing; the one-time price stays the price of a one-time-only
 * draft and equals the amount the estimate page shows for the choice.
 * Regressions it guards: the plan handing the caller the plan-member
 * discount on the one-time price, and the plan being added on a text
 * thread, next to other services, or on a bedroom-band unit.
 */
const { addRecurringPestForOneTimeAsk } = require('../services/estimator-engine/one-time-pest-both-options');
const { buildEngineInput } = require('../services/estimator-engine/draft-builder');
const { SQFT_SOURCES } = require('../services/estimator-engine/source-arbitration');
const { validateEstimateDeliveryOptions } = require('../services/estimate-delivery-options');
const { generateEstimate } = require('../services/pricing-engine');

const intentWith = (services, extra = {}) => ({
  decision: 'draft', category: 'RESIDENTIAL', is_commercial: false, address: '101 Example St, Bradenton, FL 34208',
  services, evidence: [], constraint_flags: [], uncertainties: [], confidence: 'high', ...extra,
});
const facts = {
  home: { value: 1800, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] },
  lot: { value: 8000, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected: [] },
  newConstruction: false, tenant: false,
};

describe('one-time pest ask: both options', () => {
  const onCall = { channel: 'call' };
  test('a one-time-only ask gains the quarterly plan', () => {
    const intent = intentWith({ oneTimePest: {} });
    expect(addRecurringPestForOneTimeAsk(intent, onCall)).toBe(true);
    expect(intent.services).toEqual({ oneTimePest: {}, pest: { frequency: 'quarterly' } });
  });

  test.each([
    ['the plan is already there', intentWith({ oneTimePest: {}, pest: { frequency: 'monthly' } })],
    ['another service is on the ask', intentWith({ oneTimePest: {}, lawn: {} })],
    ['no one-time pest', intentWith({ mosquito: {} })],
    ['commercial', intentWith({ oneTimePest: {} }, { is_commercial: true })],
    ['a skipped intent', intentWith({ oneTimePest: {} }, { decision: 'skip' })],
    ['a text thread, not a call', intentWith({ oneTimePest: {} }), { channel: 'sms_thread' }],
    ['a bedroom-band unit', intentWith({ oneTimePest: {} }), { channel: 'call', unitBandPricing: { eligible: true } }],
  ])('adds nothing when %s', (_label, intent, where = onCall) => {
    const before = JSON.stringify(intent.services);
    expect(addRecurringPestForOneTimeAsk(intent, where)).toBe(false);
    expect(JSON.stringify(intent.services)).toBe(before);
  });

  const price = (services, context = {}) => {
    const engineInputs = buildEngineInput({ intent: intentWith(services), propertyFacts: facts, context });
    const engineResult = generateEstimate(engineInputs);
    const line = (service) => engineResult.lineItems.find((l) => l.service === service) || {};
    return { engineInputs, engineResult, oneTime: line('one_time_pest').price, perApp: line('pest_control').perApp };
  };
  const ruleContext = { ownerRuleServices: ['pest'] };
  const both = { oneTimePest: {}, pest: { frequency: 'quarterly' } };

  test('offering the plan keeps the one-time price of a one-time-only draft', () => {
    const alone = price({ oneTimePest: {} });
    expect(alone.oneTime).toBeGreaterThan(0);
    expect(price(both, ruleContext).oneTime).toBe(alone.oneTime);
    // Without the rule's marker the engine reads the pair as a plan member.
    expect(price(both).oneTime).toBeLessThan(alone.oneTime);
  });

  test('the stored one-time price is the amount the estimate page shows', () => {
    const { ONE_TIME } = require('../services/pricing-engine/constants');
    const priced = price(both, ruleContext);
    expect(priced.oneTime).toBe(Math.max(ONE_TIME.pest.floor, Math.round(priced.perApp * ONE_TIME.pest.multiplier)));
  });

  test('the priced result passes the estimate page rule for the one-time choice', () => {
    const { engineInputs, engineResult } = price(both, ruleContext);
    expect(validateEstimateDeliveryOptions({ showOneTimeOption: true, estimateData: { engineInputs, engineResult } })).toBeNull();
  });
});
