/**
 * Commercial suite sizing, estimator-engine path end to end:
 * buildEngineInput -> generateEstimate. A commercial tenant in a
 * multi-tenant building prices off the SUITE's resolved size (never the
 * building), and a type-default size prices LOW confidence on every
 * commercial line so the low-confidence delivery gates apply.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { generateEstimate } = require('../services/pricing-engine');
const { buildEngineInput } = require('../services/estimator-engine/draft-builder');
const { commercialLowConfidenceRange } = require('../services/estimate-delivery-options');

// A 1,400 sq ft restaurant bay on a monthly program: ~$103/mo. Wide band so
// a pricing-config tweak doesn't fail this, while a whole-plaza footprint
// (~$546/mo) or a $0 manual quote still would.
const EXPECTED_MONTHLY_MIN = 85;
const EXPECTED_MONTHLY_MAX = 130;

function suiteFacts(value, source, confidence = 'medium') {
  return {
    home: { value, source, confidence, rejected: [] },
    lot: { value: null, source: 'unresolved', confidence: 'none', rejected: [] },
  };
}

function commercialIntent(services, overrides = {}) {
  return { is_commercial: true, services, commercial_risk_type: 'restaurant_food', ...overrides };
}

describe('estimator engine path — buildEngineInput -> generateEstimate', () => {
  test('a license-sized suite prices off the suite footprint (no perimeter leak), MEDIUM confidence', () => {
    const engineInput = buildEngineInput({
      intent: commercialIntent({ pest: true }),
      propertyFacts: suiteFacts(1400, 'license_seats'),
      context: {},
    });
    // The engine path never carries a separate perimeter key for commercial
    // (draft-builder.js sets footprintSqFt only).
    expect(engineInput.perimeter).toBeUndefined();
    expect(engineInput.perimeterLF).toBeUndefined();
    expect(engineInput.footprintSqFt).toBe(1400);
    expect(engineInput.buildingSizeMeasured).toBe(true);
    expect(engineInput.footprintSizeEstimated).toBeUndefined();

    const result = generateEstimate(engineInput);
    const line = result.lineItems.find((l) => l.service === 'commercial_pest');
    expect(line).toBeTruthy();
    expect(line.footprintUsed).toBe(1400);
    expect(line.commercialPricingMode).toBe('auto_estimate');
    expect(line.pricingConfidence).toBe('MEDIUM');
    expect(line.monthly).toBeGreaterThan(EXPECTED_MONTHLY_MIN);
    expect(line.monthly).toBeLessThan(EXPECTED_MONTHLY_MAX);
  });

  test('a type-default suite still auto-prices, but every commercial line is LOW and the gate trips', () => {
    const engineInput = buildEngineInput({
      intent: commercialIntent({ pest: true }),
      propertyFacts: suiteFacts(1800, 'suite_type_default', 'low'),
      context: {},
    });
    expect(engineInput.footprintSizeEstimated).toBe(true);
    expect(engineInput.buildingSizeMeasured).toBe(true);

    const result = generateEstimate(engineInput);
    const line = result.lineItems.find((l) => l.service === 'commercial_pest');
    expect(line.commercialPricingMode).toBe('auto_estimate');
    expect(line.monthly).toBeGreaterThan(0);
    expect(line.pricingConfidence).toBe('LOW');
    expect(commercialLowConfidenceRange({ lineItems: result.lineItems }).hasLowConfidence).toBe(true);
  });

  test('the LOW grading reaches every commercial footprint pricer, not only pest', () => {
    const plain = generateEstimate({
      isCommercial: true,
      category: 'COMMERCIAL',
      propertyType: 'commercial',
      commercialRiskType: 'retail_standard',
      homeSqFt: 1500,
      footprintSqFt: 1500,
      buildingSizeMeasured: true,
      stories: 1,
      services: { termiteBait: {}, rodentBait: {} },
    });
    const estimated = generateEstimate({
      isCommercial: true,
      category: 'COMMERCIAL',
      propertyType: 'commercial',
      commercialRiskType: 'retail_standard',
      homeSqFt: 1500,
      footprintSqFt: 1500,
      buildingSizeMeasured: true,
      footprintSizeEstimated: true,
      stories: 1,
      services: { termiteBait: {}, rodentBait: {} },
    });
    const priced = (r) => r.lineItems.filter((l) => String(l.service || '').startsWith('commercial_')
      && l.commercialPricingMode !== 'manual_quote');
    expect(priced(estimated).length).toBeGreaterThan(0);
    for (const l of priced(estimated)) expect(l.pricingConfidence).toBe('LOW');
    // Without the flag the same inputs are not forced LOW.
    expect(priced(plain).some((l) => l.pricingConfidence !== 'LOW')).toBe(true);
  });
});
