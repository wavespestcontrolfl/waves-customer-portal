// Estimator-engine audit 2026-08-30: lawn pricing must never produce a
// customer-ready price from an unsupported grass type or a low-confidence
// turf basis without a review marker, and the lead automation gate must
// consult estimate-level fieldVerify flags before auto-generating a draft.
const { priceLawnCare, priceOneTimeLawn, normalizeGrassType } = require('../services/pricing-engine/service-pricing');
const {
  buildAutomatedLeadDraftEstimate,
  evaluateLeadEstimateAutomationReadiness,
} = require('../services/lead-estimate-automation');

describe('lawn grass-type substitution is loud, never silent', () => {
  const property = { turfSf: 4500, turfConfidence: 'HIGH', turfBasis: 'measuredTurfSf' };

  test('an unsupported grass type prices off St. Augustine but parks for review', () => {
    const result = priceLawnCare(property, { track: 'paspalum' });
    expect(result.track).toBe('st_augustine');
    expect(result.requestedGrassType).toBe('paspalum');
    expect(result.grassTypeWasDefaulted).toBe(true);
    expect(result.requiresManualReview).toBe(true);
    expect(result.manualReviewReasons).toContain('unknown_grass_type_priced_st_augustine');
    expect(result.notes.join(' ')).toMatch(/paspalum/i);

    // Same numbers as an explicit St. Augustine quote — the flag changes
    // routing, never the price.
    const stAug = priceLawnCare(property, { track: 'st_augustine' });
    expect(result.annual).toBe(stAug.annual);
    expect(result.perApp).toBe(stAug.perApp);
  });

  test('a supported track and an empty track stay unflagged', () => {
    for (const track of ['st_augustine', 'bermuda', 'zoysia', 'bahia', '']) {
      const result = priceLawnCare(property, { track });
      expect(result.grassTypeWasDefaulted).toBe(false);
      expect(result.requiresManualReview).toBe(false);
      expect(result.manualReviewReasons).toEqual([]);
    }
  });

  test('one-time lawn inherits the review contract from the underlying pricer', () => {
    const result = priceOneTimeLawn(property, { track: 'paspalum' });
    expect(result.grassTypeWasDefaulted).toBe(true);
    expect(result.requestedGrassType).toBe('paspalum');
    expect(result.requiresManualReview).toBe(true);
    expect(result.manualReviewReasons).toContain('unknown_grass_type_priced_st_augustine');

    const clean = priceOneTimeLawn(property, { track: 'st_augustine' });
    expect(clean.requiresManualReview).toBe(false);
    expect(clean.price).toBe(result.price);
  });

  test('normalizeGrassType keeps its historical default contract', () => {
    expect(normalizeGrassType('paspalum')).toBe('st_augustine');
    expect(normalizeGrassType('')).toBe('st_augustine');
    expect(normalizeGrassType('C1')).toBe('bermuda');
  });
});

describe('low-confidence turf parks the lawn line', () => {
  test('LOW turfConfidence sets requiresManualReview', () => {
    const result = priceLawnCare(
      { turfSf: 4500, turfConfidence: 'LOW', turfBasis: 'lotFallback' },
      { track: 'st_augustine' }
    );
    expect(result.requiresManualReview).toBe(true);
    expect(result.manualReviewReasons).toContain('low_confidence_turf_requires_field_verification');
  });

  test('a FIELD_VERIFY_TURF_SQFT flag parks even at MEDIUM grade (plausible-max cap)', () => {
    const result = priceLawnCare(
      {
        turfSf: 8000,
        turfConfidence: 'MEDIUM',
        turfBasis: 'plausibleMaxTurfCap',
        turfFlags: ['FIELD_VERIFY_TURF_SQFT', 'TURF_ESTIMATE_EXCEEDS_PLAUSIBLE_MAX'],
      },
      { track: 'st_augustine' }
    );
    expect(result.requiresManualReview).toBe(true);
    expect(result.manualReviewReasons).toContain('low_confidence_turf_requires_field_verification');
  });

  test('MEDIUM and HIGH turfConfidence do not park on confidence alone', () => {
    for (const turfConfidence of ['MEDIUM', 'HIGH']) {
      const result = priceLawnCare(
        { turfSf: 4500, turfConfidence, turfBasis: 'estimatedTurfSf' },
        { track: 'st_augustine' }
      );
      expect(result.requiresManualReview).toBe(false);
    }
  });
});

describe('lead automation consults estimate fieldVerify flags', () => {
  function lawnReadiness() {
    return evaluateLeadEstimateAutomationReadiness({
      phone: '+19415550199',
      intake: {
        email: 'lead@example.com',
        serviceInterest: 'Lawn Care',
        normalizedAddress: {
          line1: '123 Main St',
          city: 'Venice',
          state: 'FL',
          zip: '34285',
        },
      },
    });
  }

  test('a lot-fallback turf basis (LOW, FIELD_VERIFY_TURF_SQFT) parks the draft', () => {
    const draft = buildAutomatedLeadDraftEstimate({
      readiness: lawnReadiness(),
      intake: { serviceInterest: 'Lawn Care' },
      body: { homeSqFt: 2200, lotSqFt: 9000 },
    });

    expect(draft.automation.status).toBe('manual_review_required');
    expect(draft.automation.generated).toBe(false);
    expect(draft.automation.fieldVerify).toContain('FIELD_VERIFY_TURF_SQFT');
    expect(draft.automation.quoteRequiredReason).toBeTruthy();
  });

  test('a non-turf-priced draft (mosquito) still auto-generates', () => {
    const draft = buildAutomatedLeadDraftEstimate({
      readiness: evaluateLeadEstimateAutomationReadiness({
        phone: '+19415550199',
        intake: {
          email: 'lead@example.com',
          serviceInterest: 'Recurring Mosquito Control',
          normalizedAddress: { line1: '123 Main St', city: 'Venice', state: 'FL', zip: '34285' },
        },
      }),
      intake: { serviceInterest: 'Recurring Mosquito Control' },
      body: { homeSqFt: 2200, lotSqFt: 9000 },
    });

    expect(draft.automation.status).toBe('generated');
    expect(draft.automation.generated).toBe(true);
    expect(draft.automation.fieldVerify).toEqual([]);
    expect(draft.monthly).toBeGreaterThan(0);
  });
});
