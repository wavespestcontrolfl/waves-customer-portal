/**
 * Owner ruling 2026-11-23: a one-time pest ask shows BOTH options on the
 * estimate (the plan and the one-time price).
 * Behavior: on a call, a one-time-only pest intent is priced as the
 * quarterly plan, and the priced result passes the estimate page's own rule
 * for the [Recurring | One-time] choice with no one-time row stored.
 * Regressions it guards: a second stored one-time price (it disagreed with
 * the page's amount for members, older homes and band units), and the swap
 * on a text thread, next to other services, for a current customer, or on
 * a bedroom-band unit.
 */
const { offerPlanWithOneTimeChoice } = require('../services/estimator-engine/one-time-pest-both-options');
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

  test('a one-time-only ask on a call is priced as the quarterly plan', () => {
    const intent = intentWith({ oneTimePest: {} });
    expect(offerPlanWithOneTimeChoice(intent, onCall)).toBe(true);
    expect(intent.services).toEqual({ pest: { frequency: 'quarterly' } });
  });

  test.each([
    ['the plan is already there', intentWith({ oneTimePest: {}, pest: { frequency: 'monthly' } })],
    ['another service is on the ask', intentWith({ oneTimePest: {}, lawn: {} })],
    ['no one-time pest', intentWith({ mosquito: {} })],
    ['commercial', intentWith({ oneTimePest: {} }, { is_commercial: true })],
    ['a skipped intent', intentWith({ oneTimePest: {} }, { decision: 'skip' })],
    ['a text thread, not a call', intentWith({ oneTimePest: {} }), { channel: 'sms_thread' }],
    ['a bedroom-band unit', intentWith({ oneTimePest: {} }), { channel: 'call', unitBandPricing: { eligible: true } }],
    ['a current customer', intentWith({ oneTimePest: {} }), { channel: 'call', currentCustomer: true }],
    ['the lookup says the property is commercial', intentWith({ oneTimePest: {} }), { channel: 'call', propertyType: 'commercial' }],
    ['the lookup says the property is an office', intentWith({ oneTimePest: {} }), { channel: 'call', propertyType: 'office' }],
  ])('leaves the ask alone when %s', (_label, intent, where = onCall) => {
    const before = JSON.stringify(intent.services);
    expect(offerPlanWithOneTimeChoice(intent, where)).toBe(false);
    expect(JSON.stringify(intent.services)).toBe(before);
  });

  test('the priced plan passes the estimate page rule for the one-time choice, with no one-time row', () => {
    const intent = intentWith({ oneTimePest: {} });
    offerPlanWithOneTimeChoice(intent, onCall);
    const engineInputs = buildEngineInput({ intent, propertyFacts: facts, context: {} });
    const engineResult = generateEstimate(engineInputs);
    expect(engineResult.lineItems.map((l) => l.service)).toEqual(['pest_control']);
    expect(validateEstimateDeliveryOptions({ showOneTimeOption: true, estimateData: { engineInputs, engineResult } })).toBeNull();
  });
});
