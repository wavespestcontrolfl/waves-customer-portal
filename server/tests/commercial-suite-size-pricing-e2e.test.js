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
    // Not a measured building — recurring pest is opted in separately.
    expect(engineInput.buildingSizeMeasured).toBe(false);

    const result = generateEstimate(engineInput);
    const line = result.lineItems.find((l) => l.service === 'commercial_pest');
    expect(line.commercialPricingMode).toBe('auto_estimate');
    expect(line.monthly).toBeGreaterThan(0);
    expect(line.pricingConfidence).toBe('LOW');
    expect(commercialLowConfidenceRange({ lineItems: result.lineItems }).hasLowConfidence).toBe(true);
  });

  // Codex #4872 r1 P1: a type default is NOT a measured building. Recurring
  // commercial pest is the only pricer opted in (footprintSizeEstimated);
  // every measured-only guard keeps its manual-quote posture.
  const typeDefaultInput = (services) => ({
    isCommercial: true,
    category: 'COMMERCIAL',
    propertyType: 'commercial',
    commercialRiskType: 'retail_standard',
    homeSqFt: 1500,
    footprintSqFt: 1500,
    buildingSizeMeasured: false,
    footprintSizeEstimated: true,
    stories: 1,
    services,
  });

  test('type default: recurring pest prices LOW; termite bait and rodent bait stay manual quotes', () => {
    const result = generateEstimate(typeDefaultInput({ pest: { frequency: 'monthly' }, termiteBait: {}, rodentBait: {} }));
    const pest = result.lineItems.find((l) => l.service === 'commercial_pest');
    expect(pest.commercialPricingMode).toBe('auto_estimate');
    expect(pest.pricingConfidence).toBe('LOW');
    for (const service of ['commercial_termite_bait', 'commercial_rodent_bait']) {
      const line = result.lineItems.find((l) => l.service === service);
      expect(line).toBeTruthy();
      expect(line.quoteRequired).toBe(true);
    }
  });

  test('type default: a hotel bed-bug job never gets an exact price off the guessed footprint', () => {
    const saved = process.env.GATE_COMMERCIAL_ONETIME_SCOPED;
    process.env.GATE_COMMERCIAL_ONETIME_SCOPED = 'true';
    try {
      const measured = generateEstimate({ ...typeDefaultInput({ bedBug: { method: 'CHEMICAL', rooms: 3, severity: 'light', prepStatus: 'ready', occupancyType: 'hotel' } }), buildingSizeMeasured: true, footprintSizeEstimated: undefined });
      const guessed = generateEstimate(typeDefaultInput({ bedBug: { method: 'CHEMICAL', rooms: 3, severity: 'light', prepStatus: 'ready', occupancyType: 'hotel' } }));
      // Off the guess, no priced bed-bug line exists — the request falls to
      // the commercial manual-quote row with no price.
      expect(guessed.lineItems.some((l) => l.service === 'bed_bug')).toBe(false);
      const manual = guessed.lineItems.find((l) => l.quoteRequired === true);
      expect(manual).toBeTruthy();
      expect(manual.commercialPricingMode).toBe('manual_quote');
      // Control: the same scoped job on a measured building does price.
      const priced = measured.lineItems.find((l) => l.service === 'bed_bug');
      expect(priced).toBeTruthy();
      expect(priced.quoteRequired).not.toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GATE_COMMERCIAL_ONETIME_SCOPED;
      else process.env.GATE_COMMERCIAL_ONETIME_SCOPED = saved;
    }
  });
});
