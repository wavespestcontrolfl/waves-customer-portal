/**
 * A suite a LISTING sized keeps its size and link, but the engine runs the
 * DBPR license check once more with the call's phone (the tie-breaker when
 * several licenses share a suite) for the classification only (PR 5b).
 */
jest.mock('../models/db', () => {
  const mock = jest.fn(() => { throw new Error('db not expected'); });
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const resolved = { current: null, calls: [] };
jest.mock('../services/commercial-suite-size', () => ({
  resolveCommercialSuiteSize: jest.fn(async (input, opts) => { resolved.calls.push({ input, opts }); if (resolved.current instanceof Error) throw resolved.current; return resolved.current; }),
  SOURCES: { LISTING_VERIFIED_TEXT: 'listing_verified_text', LICENSE_SEATS: 'license_seats', SUITE_TYPE_DEFAULT: 'suite_type_default' },
}));

const { _private: { classifyListingSuiteByLicense } } = require('../services/estimator-engine');

const LISTING = { value: 1350, source: 'listing_verified_text', confidence: 'medium', url: 'https://www.loopnet.com/x', businessName: null, businessType: null, evidence: [] };
const ARGS = { addressLine: '4400 Test Commons Pkwy Suite 103, Bradenton, FL 34202', phone: '+19415550100', commercialRiskType: null, commercialSubtype: null };

beforeEach(() => { resolved.calls.length = 0; });

test('a license found with the phone classifies the suite; the listing size, source and link stand', async () => {
  resolved.current = { value: 1400, source: 'license_seats', businessName: 'Example Taco Shop', seats: 25 };
  const out = await classifyListingSuiteByLicense(LISTING, ARGS);
  expect(out).toMatchObject({ value: 1350, source: 'listing_verified_text', url: 'https://www.loopnet.com/x', licenseBacked: true, businessType: 'restaurant_food', businessName: 'Example Taco Shop', seats: 25 });
  expect(resolved.calls[0].input.phone).toBe('+19415550100');
  expect(resolved.calls[0].opts).toMatchObject({ skipWebSearch: true, skipListing: true });
});

test('no license (a type default), or a failed check, leaves the listing result untouched', async () => {
  resolved.current = { value: 1500, source: 'suite_type_default' };
  expect(await classifyListingSuiteByLicense(LISTING, ARGS)).toBe(LISTING);
  resolved.current = new Error('dbpr down');
  expect(await classifyListingSuiteByLicense(LISTING, ARGS)).toBe(LISTING);
});
