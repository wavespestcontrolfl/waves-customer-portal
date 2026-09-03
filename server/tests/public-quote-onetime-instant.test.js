/**
 * Service-menu phase 2 (2026-09-03): one-time mosquito and lawn pest
 * knockdown are advertised as public_instant_quote, so the /calculate route
 * must accept and price both from the lookup alone. The menu ⇄ route parity
 * test in public-services-menu.test.js pins the pair; this file pins the
 * route's side.
 */
const { generateEstimate } = require('../services/pricing-engine');
const { _internals, PUBLIC_QUOTE_SERVICE_KEYS } = require('../routes/public-quote');
const { quoteServicesForKey, mergeKeyedRequestOptions } = require('../services/public-services-menu');
const {
  buildPublicQuoteServiceInterest, buildCompactPublicQuoteServiceInterest, derivePerApplication, lotPricedServiceRequested,
} = _internals;

const BASE_PROPERTY = { homeSqFt: 1800, lotSqFt: 8783, stories: 1, yearBuilt: 2005, estimatedTurfSf: 4500 };

describe('oneTimeMosquito as a public quote service', () => {
  test('is an accepted service key', () => {
    expect(PUBLIC_QUOTE_SERVICE_KEYS).toContain('oneTimeMosquito');
  });
  test('labels name the treatment; compact label stays short', () => {
    expect(buildPublicQuoteServiceInterest({ oneTimeMosquito: {} })).toBe('One-Time Mosquito Treatment');
    expect(buildCompactPublicQuoteServiceInterest({ oneTimeMosquito: {} })).toBe('One-Time Mosquito');
  });
  test('prices one one-time line by lot area with no recurring spread', () => {
    const estimate = generateEstimate({ ...BASE_PROPERTY, services: quoteServicesForKey('mosquito_one_time') });
    const line = estimate.lineItems.find((l) => l.service === 'one_time_mosquito');
    expect(line).toBeDefined();
    expect(Number(line.price)).toBeGreaterThan(0);
    expect(line.requiresManualReview).toBeFalsy();
    expect(Number(estimate.summary.recurringMonthlyAfterDiscount || 0)).toBe(0);
    expect(derivePerApplication(estimate)).toBeNull();
    // Larger treatable area, higher price — the lot drives it, not the home.
    const bigLot = generateEstimate({ ...BASE_PROPERTY, lotSqFt: 30000, services: quoteServicesForKey('mosquito_one_time') });
    expect(Number(bigLot.lineItems.find((l) => l.service === 'one_time_mosquito').price)).toBeGreaterThan(Number(line.price));
  });
  test('a lot the lookup flagged verify-first parks it like the recurring program', () => {
    // The route's lot-flag park (lot_size_requires_verification) reads this
    // predicate; without it a flagged lot priced the synthetic sqft×4 area.
    expect(lotPricedServiceRequested({ oneTimeMosquito: {} })).toBe(true);
    expect(lotPricedServiceRequested({ mosquito: { tier: 'silver' } })).toBe(true);
    expect(lotPricedServiceRequested({ treeShrub: {} })).toBe(true);
    expect(lotPricedServiceRequested({ rodentInspection: {} })).toBe(false);
    expect(lotPricedServiceRequested({ lawnPestControl: {} })).toBe(false);
    expect(lotPricedServiceRequested({})).toBe(false);
  });
});

describe('lawn pest knockdown as a keyed public quote', () => {
  test('the site-collected grass track prices the knockdown on that track', () => {
    const keyed = (bodyServices) => generateEstimate({
      ...BASE_PROPERTY,
      services: mergeKeyedRequestOptions(quoteServicesForKey('lawn_pest_knockdown'), bodyServices),
    }).lineItems.find((l) => l.name === 'Lawn Pest Knockdown Service');
    expect(keyed({}).track).toBe('st_augustine');
    expect(keyed({ lawn: { track: 'bahia' } }).track).toBe('bahia');
    expect(keyed({ lawn: { track: 'bahia' } }).requiresManualReview).toBeFalsy();
  });
  test('a lot-only lookup routes it to review instead of pricing a lot-derived guess', () => {
    const { estimatedTurfSf, ...lotOnly } = BASE_PROPERTY;
    const line = generateEstimate({ ...lotOnly, services: quoteServicesForKey('lawn_pest_knockdown') })
      .lineItems.find((l) => l.name === 'Lawn Pest Knockdown Service');
    expect(line.requiresManualReview).toBe(true);
  });
});
