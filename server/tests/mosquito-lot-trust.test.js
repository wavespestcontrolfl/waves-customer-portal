/**
 * Owner ruling 2026-09-03: no mosquito quote prices off a guessed lot. The
 * public quote route passes lotSizeMeasured:false when the lot is the
 * synthetic sqft×4 fallback (wizard lookup miss) or a direct-API lot posted
 * without lotSizeConfirmed; every mosquito pricer must route that to review
 * and price only a measured / confirmed lot. Commercial mosquito has done
 * this since the auto-price gate; one-time joined on #3836; this pins the
 * recurring residential program alongside them.
 */
const { generateEstimate } = require('../services/pricing-engine');

const BASE = { homeSqFt: 1800, lotSqFt: 8783, stories: 1, yearBuilt: 2005 };
const line = (input, service) => generateEstimate(input).lineItems.find((l) => l.service === service);

describe('mosquito lines on a synthesized lot', () => {
  test.each([
    ['recurring seasonal9', { mosquito: { tier: 'seasonal9' } }, 'mosquito'],
    ['recurring monthly12', { mosquito: { tier: 'monthly12' } }, 'mosquito'],
    ['one-time', { oneTimeMosquito: {} }, 'one_time_mosquito'],
  ])('%s routes to review when lotSizeMeasured is false', (_label, services, service) => {
    const l = line({ ...BASE, lotSizeMeasured: false, services }, service);
    expect(l).toBeDefined();
    expect(l.requiresManualReview).toBe(true);
    expect(l.manualReviewReasons).toContain('mosquito_treatable_area_unverified');
  });

  test.each([
    ['measured lot (true)', true],
    ['admin / unspecified (undefined)', undefined],
  ])('recurring mosquito prices on a %s', (_label, lotSizeMeasured) => {
    const l = line({ ...BASE, lotSizeMeasured, services: { mosquito: { tier: 'seasonal9' } } }, 'mosquito');
    expect(l.requiresManualReview).toBeFalsy();
    expect(l.manualReviewReasons).not.toContain('mosquito_treatable_area_unverified');
    expect(Number(l.annual)).toBeGreaterThan(0);
  });

  test('the flag never reaches lot-independent lines', () => {
    const est = generateEstimate({ ...BASE, lotSizeMeasured: false, services: { pest: { frequency: 'quarterly' }, rodentBait: {} } });
    for (const l of est.lineItems) {
      expect(l.manualReviewReasons || []).not.toContain('mosquito_treatable_area_unverified');
    }
  });
});
