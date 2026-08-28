/**
 * Restriction policy = the legal ceiling above the watering model. Pins the
 * fail-closed rule: past expiry with nothing newer configured there is NO
 * policy (never a silent 2-day fallback), env JSON overrides the default,
 * malformed input yields null.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const logger = require('../services/logger');
const { currentRestrictionPolicy, resolveRestrictionCounty, DEFAULT_POLICY } = require('../config/irrigation-restrictions');

const IN_FORCE = new Date('2026-08-28T12:00:00Z');
const AFTER = new Date('2026-10-02T12:00:00Z');

describe('currentRestrictionPolicy', () => {
  beforeEach(() => logger.error.mockClear());

  test('default = SWFWMD Modified Phase III, one day per week through 2026-10-01', () => {
    const p = currentRestrictionPolicy(IN_FORCE, { env: {}, county: 'Manatee' });
    expect(p).toMatchObject({ maxDaysPerWeek: 1, expiresOn: '2026-10-01' });
    expect(p.label).toMatch(/Phase III/);
    expect(DEFAULT_POLICY.maxDaysPerWeek).toBe(1);
  });

  test('last day of the order is still in force; the day after is NOT — null, logged', () => {
    expect(currentRestrictionPolicy(new Date('2026-10-01T23:00:00Z'), { env: {}, county: 'Sarasota' })).not.toBeNull(); // 19:00 ET Oct 1
    expect(currentRestrictionPolicy(AFTER, { env: {}, county: 'Manatee' })).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('expired 2026-10-01'));
  });

  test('IRRIGATION_RESTRICTION_POLICY env JSON overrides the default', () => {
    const env = { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, effectiveFrom: '2026-10-02', expiresOn: '2027-12-31', label: 'SWFWMD year-round rule', hoursNote: 'before 10 a.m. or after 4 p.m.' }) };
    expect(currentRestrictionPolicy(AFTER, { env, county: 'Manatee' })).toMatchObject({ maxDaysPerWeek: 2, label: 'SWFWMD year-round rule' });
    // Not yet effective → null (no fallback to the default either).
    expect(currentRestrictionPolicy(IN_FORCE, { env, county: 'Manatee' })).toBeNull();
  });

  test('malformed env policy → null (fail closed), never the default', () => {
    expect(currentRestrictionPolicy(IN_FORCE, { env: { IRRIGATION_RESTRICTION_POLICY: '{not json' }, county: 'Manatee' })).toBeNull(); // configured-but-unusable ≠ unset
    expect(currentRestrictionPolicy(IN_FORCE, { env: { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 9, expiresOn: '2027-01-01' }) }, county: 'Manatee' })).toBeNull();
    expect(currentRestrictionPolicy(IN_FORCE, { env: { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, expiresOn: 'soon' }) }, county: 'Manatee' })).toBeNull();
    // Shape-valid but not a real date, and an inverted range: both fail closed.
    expect(currentRestrictionPolicy(IN_FORCE, { env: { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, expiresOn: '2026-02-31' }) }, county: 'Manatee' })).toBeNull();
    expect(currentRestrictionPolicy(IN_FORCE, { env: { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, expiresOn: '2026-99-99' }) }, county: 'Manatee' })).toBeNull();
    expect(currentRestrictionPolicy(IN_FORCE, { env: { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, effectiveFrom: '2026-12-01', expiresOn: '2026-09-01' }) }, county: 'Manatee' })).toBeNull();
  });
});

describe('jurisdiction', () => {
  test('the default order applies in Manatee and Sarasota; partial Charlotte and unknown county → no policy (fail closed)', () => {
    expect(currentRestrictionPolicy(IN_FORCE, { env: {}, county: 'Sarasota' })).toMatchObject({ maxDaysPerWeek: 1, county: 'Sarasota' });
    expect(currentRestrictionPolicy(IN_FORCE, { env: {}, county: 'Charlotte' })).toBeNull();
    expect(currentRestrictionPolicy(IN_FORCE, { env: {}, county: 'Hillsborough' })).toBeNull();
    expect(currentRestrictionPolicy(IN_FORCE, { env: {} })).toBeNull();
  });

  test('an env policy with no coverage applies wherever it is configured', () => {
    const env = { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, expiresOn: '2027-12-31', label: 'year-round' }) };
    expect(currentRestrictionPolicy(IN_FORCE, { env, county: 'Charlotte' })).toMatchObject({ maxDaysPerWeek: 2 });
  });

  test('resolveRestrictionCounty: turf-profile county first, then whole-county service cities, else null', () => {
    expect(resolveRestrictionCounty({ county: 'sarasota county', city: 'Sarasota' })).toBe('Sarasota'); // normalized
    expect(resolveRestrictionCounty({ county: 'sarasota county', city: 'Bradenton' })).toBe('Manatee'); // conflicting current city wins
    expect(resolveRestrictionCounty({ city: 'Lakewood Ranch' })).toBe('Manatee');
    expect(resolveRestrictionCounty({ city: 'North Port' })).toBe('Sarasota');
    expect(resolveRestrictionCounty({ city: 'Englewood' })).toBeNull(); // straddles counties
    expect(resolveRestrictionCounty({})).toBeNull();
    // Stale profile (same guard as the plan engine): profile city ≠ customer
    // city → the profile's county is dropped; the current city decides.
    expect(resolveRestrictionCounty({ county: 'Manatee', profileCity: 'Bradenton', city: 'Port Charlotte' })).toBe('Charlotte');
    expect(resolveRestrictionCounty({ county: 'Manatee', profileCity: 'Bradenton', city: 'Bradenton' })).toBe('Manatee');
    // No profile city context but the current city maps to a DIFFERENT county → the current city wins.
    expect(resolveRestrictionCounty({ county: 'Manatee', profileCity: null, city: 'Port Charlotte' })).toBe('Charlotte');
    expect(resolveRestrictionCounty({ county: 'Manatee', profileCity: null, city: 'Bradenton' })).toBe('Manatee');
    expect(resolveRestrictionCounty({ county: 'Manatee', profileCity: null, city: 'Englewood' })).toBe('Manatee'); // unmapped city → profile county kept
  });
});
