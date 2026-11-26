/**
 * Owner ruling 2026-11-23: a one-time pest ask shows BOTH options on the
 * estimate (the plan and the one-time price).
 * Behavior: a one-time-only pest intent gains the quarterly plan before
 * pricing, and the priced result passes the estimate page's own rule for
 * the [Recurring | One-time] choice. Regression it guards: the plan being
 * added next to other services (where the page cannot offer the choice).
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
  test('a one-time-only ask gains the quarterly plan', () => {
    const intent = intentWith({ oneTimePest: {} });
    expect(addRecurringPestForOneTimeAsk(intent)).toBe(true);
    expect(intent.services).toEqual({ oneTimePest: {}, pest: { frequency: 'quarterly' } });
  });

  test.each([
    ['the plan is already there', intentWith({ oneTimePest: {}, pest: { frequency: 'monthly' } })],
    ['another service is on the ask', intentWith({ oneTimePest: {}, lawn: {} })],
    ['no one-time pest', intentWith({ mosquito: {} })],
    ['commercial', intentWith({ oneTimePest: {} }, { is_commercial: true })],
    ['a skipped intent', intentWith({ oneTimePest: {} }, { decision: 'skip' })],
  ])('adds nothing when %s', (_label, intent) => {
    const before = JSON.stringify(intent.services);
    expect(addRecurringPestForOneTimeAsk(intent)).toBe(false);
    expect(JSON.stringify(intent.services)).toBe(before);
  });

  test('the priced result passes the estimate page rule for the one-time choice', () => {
    const intent = intentWith({ oneTimePest: {} });
    addRecurringPestForOneTimeAsk(intent);
    const engineInputs = buildEngineInput({ intent, propertyFacts: facts, context: {} });
    const engineResult = generateEstimate(engineInputs);
    const services = engineResult.lineItems.map((l) => l.service);
    expect(services).toEqual(expect.arrayContaining(['pest_control', 'one_time_pest']));
    expect(validateEstimateDeliveryOptions({ showOneTimeOption: true, estimateData: { engineInputs, engineResult } })).toBeNull();
  });
});
