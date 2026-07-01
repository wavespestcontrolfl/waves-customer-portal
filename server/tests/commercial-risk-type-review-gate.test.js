process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Commercial risk-type (business-type) review gate (owner-locked risk-type lane,
// decision 1). A commercial estimate with a pest/rodent line must be classified
// before it can be sent/accepted — the risk type drives the service cadence, and
// a NULL default would silently under/over-cadence. commercialRiskTypeReviewNeeded
// is the shared decision function behind both the send + manual-accept gates and
// the admin "Risk Type" review chip/badge.

const { commercialRiskTypeReviewNeeded } = require('../services/estimate-delivery-options');

const data = (o) => JSON.stringify(o);
const autoPest = { service: 'commercial_pest', commercialPricingMode: 'auto_estimate', annual: 2400, visitsPerYear: 12 };
const autoRodent = { service: 'commercial_rodent_bait', commercialPricingMode: 'auto_estimate', annual: 1080, visitsPerYear: 4 };

describe('commercialRiskTypeReviewNeeded', () => {
  test('auto-priced commercial pest line with no risk type → needs review', () => {
    expect(commercialRiskTypeReviewNeeded(data({
      result: { lineItems: [autoPest] },
    }))).toBe(true);
  });

  test('auto-priced commercial rodent line with no risk type → needs review', () => {
    expect(commercialRiskTypeReviewNeeded(data({
      result: { lineItems: [autoRodent] },
    }))).toBe(true);
  });

  test('a valid business type (from options OR profile) clears it', () => {
    expect(commercialRiskTypeReviewNeeded(data({
      result: { lineItems: [autoPest] },
      engineRequest: { options: { commercialRiskType: 'office_low' } },
    }))).toBe(false);
    expect(commercialRiskTypeReviewNeeded(data({
      result: { lineItems: [autoRodent] },
      engineRequest: { profile: { commercialRiskType: 'warehouse_distribution' } },
    }))).toBe(false);
  });

  test('an unrecognized business type still needs review (fail closed on classification)', () => {
    expect(commercialRiskTypeReviewNeeded(data({
      result: { lineItems: [autoPest] },
      engineRequest: { options: { commercialRiskType: 'bogus' } },
    }))).toBe(true);
  });

  test('a MANUAL-quote commercial pest line is not cadence-relevant (not gated)', () => {
    // A manual quote / one-time commercial pest carries the service key but has no
    // engine cadence — the quote-required gate handles it, not this one.
    expect(commercialRiskTypeReviewNeeded(data({
      result: { lineItems: [{ service: 'commercial_pest', commercialPricingMode: 'manual_quote', quoteRequired: true, annual: null }] },
    }))).toBe(false);
  });

  test('an authored commercial proposal is never risk-type gated', () => {
    expect(commercialRiskTypeReviewNeeded(data({
      proposal: { enabled: true },
      result: { lineItems: [autoPest] },
    }))).toBe(false);
  });

  test('engineInputs-only commercial pest/rodent selection still fails closed', () => {
    expect(commercialRiskTypeReviewNeeded(data({
      engineRequest: { profile: { isCommercial: true }, selectedServices: ['PEST'] },
    }))).toBe(true);
    // …but a valid type clears it.
    expect(commercialRiskTypeReviewNeeded(data({
      engineRequest: { profile: { isCommercial: true, commercialRiskType: 'hotel_resort' }, selectedServices: ['RODENT_BAIT'] },
    }))).toBe(false);
    // …and residential selection is unaffected.
    expect(commercialRiskTypeReviewNeeded(data({
      engineRequest: { profile: { isCommercial: false }, selectedServices: ['PEST'] },
    }))).toBe(false);
  });

  test('a results.pest stat array does not false-positive as a pest selection', () => {
    expect(commercialRiskTypeReviewNeeded(data({
      isCommercial: true,
      result: { results: { pest: [{ apps: 4 }] }, lineItems: [{ service: 'commercial_lawn', commercialPricingMode: 'auto_estimate', annual: 1200 }] },
    }))).toBe(false);
  });

  test('a commercial estimate WITHOUT a pest/rodent line does not need a risk type', () => {
    expect(commercialRiskTypeReviewNeeded(data({
      result: { lineItems: [
        { service: 'commercial_lawn', commercialPricingMode: 'auto_estimate', annual: 1200 },
        { service: 'commercial_tree_shrub', commercialPricingMode: 'auto_estimate', annual: 900 },
      ] },
    }))).toBe(false);
  });

  test('residential estimates are unaffected', () => {
    expect(commercialRiskTypeReviewNeeded(data({
      result: { lineItems: [{ service: 'pest_control' }, { service: 'rodent_bait' }] },
    }))).toBe(false);
  });

  test('the explicit riskTypeNeedsReview flag forces review (Phase 3 public "Other" path)', () => {
    expect(commercialRiskTypeReviewNeeded(data({ riskTypeNeedsReview: true }))).toBe(true);
  });

  test('empty / unparseable data is safe (no review)', () => {
    expect(commercialRiskTypeReviewNeeded(null)).toBe(false);
    expect(commercialRiskTypeReviewNeeded('')).toBe(false);
    expect(commercialRiskTypeReviewNeeded('{not json')).toBe(false);
  });
});
