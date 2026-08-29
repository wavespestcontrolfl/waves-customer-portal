/**
 * Rodent Inspection on the public quote route (quote-to-estimate alignment
 * C2; owner ruling 2026-08-29: flat $75, instant on the website).
 * The public services menu advertises it as public_instant_quote, so the
 * /calculate route must accept and price it — the menu ⇄ route parity test
 * in public-services-menu.test.js pins the pair.
 */
const { generateEstimate } = require('../services/pricing-engine');
const { _internals, PUBLIC_QUOTE_SERVICE_KEYS } = require('../routes/public-quote');
const { buildPublicQuoteServiceInterest, buildCompactPublicQuoteServiceInterest, derivePerApplication } = _internals;

const BASE_PROPERTY = { homeSqFt: 1800, lotSqFt: 8783, stories: 1, yearBuilt: 2005 };

describe('rodentInspection as a public quote service', () => {
  test('is an accepted service key', () => {
    expect(PUBLIC_QUOTE_SERVICE_KEYS).toContain('rodentInspection');
  });
  test('labels carry the catalog name; compact label stays short', () => {
    expect(buildPublicQuoteServiceInterest({ rodentInspection: {} })).toBe('Rodent Inspection Service');
    expect(buildCompactPublicQuoteServiceInterest({ rodentInspection: {} })).toBe('Rodent Inspection');
  });
  test('the engine prices it as one flat one-time line with no recurring spread', () => {
    const estimate = generateEstimate({ ...BASE_PROPERTY, services: { rodentInspection: {} } });
    const line = estimate.lineItems.find((l) => l.service === 'rodent_inspection');
    expect(line).toBeDefined();
    expect(Number(line.price)).toBe(75);
    expect(Number(estimate.summary.oneTimeTotal)).toBe(75);
    expect(Number(estimate.summary.recurringMonthlyAfterDiscount || 0)).toBe(0);
    expect(derivePerApplication(estimate)).toBeNull();
  });
  test('the fee does not depend on the property (flat, per owner ruling)', () => {
    const small = generateEstimate({ homeSqFt: 900, lotSqFt: 4000, stories: 1, yearBuilt: 1970, services: { rodentInspection: {} } });
    const large = generateEstimate({ homeSqFt: 4200, lotSqFt: 22000, stories: 2, yearBuilt: 2019, services: { rodentInspection: {} } });
    expect(Number(small.summary.oneTimeTotal)).toBe(75);
    expect(Number(large.summary.oneTimeTotal)).toBe(75);
  });
});
