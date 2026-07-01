process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Commercial risk-type (business-type) review gate (owner-locked risk-type lane,
// decision 1). A commercial estimate with a pest/rodent line must be classified
// before it can be sent/accepted — the risk type drives the service cadence, and
// a NULL default would silently under/over-cadence. commercialRiskTypeReviewNeeded
// is the shared decision function behind both the send + manual-accept gates and
// the admin "Risk Type" review chip/badge.

const { commercialRiskTypeReviewNeeded } = require('../services/estimate-delivery-options');

const data = (o) => JSON.stringify(o);

describe('commercialRiskTypeReviewNeeded', () => {
  test('commercial pest line with no risk type → needs review', () => {
    expect(commercialRiskTypeReviewNeeded(data({
      result: { lineItems: [{ service: 'commercial_pest' }] },
    }))).toBe(true);
  });

  test('commercial rodent line with no risk type → needs review', () => {
    expect(commercialRiskTypeReviewNeeded(data({
      result: { lineItems: [{ service: 'commercial_rodent_bait' }] },
    }))).toBe(true);
  });

  test('a valid business type (from options OR profile) clears it', () => {
    expect(commercialRiskTypeReviewNeeded(data({
      result: { lineItems: [{ service: 'commercial_pest' }] },
      engineRequest: { options: { commercialRiskType: 'office_low' } },
    }))).toBe(false);
    expect(commercialRiskTypeReviewNeeded(data({
      result: { lineItems: [{ service: 'commercial_rodent_bait' }] },
      engineRequest: { profile: { commercialRiskType: 'warehouse_distribution' } },
    }))).toBe(false);
  });

  test('an unrecognized business type still needs review (fail closed on classification)', () => {
    expect(commercialRiskTypeReviewNeeded(data({
      result: { lineItems: [{ service: 'commercial_pest' }] },
      engineRequest: { options: { commercialRiskType: 'bogus' } },
    }))).toBe(true);
  });

  test('a commercial estimate WITHOUT a pest/rodent line does not need a risk type', () => {
    expect(commercialRiskTypeReviewNeeded(data({
      result: { lineItems: [{ service: 'commercial_lawn' }, { service: 'commercial_tree_shrub' }] },
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
