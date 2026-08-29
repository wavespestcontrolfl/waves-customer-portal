/**
 * Restriction policy = the legal ceiling above the watering model. Pins the
 * fail-closed rule: past expiry with nothing newer configured there is NO
 * policy (never a silent 2-day fallback), env JSON overrides the default,
 * malformed input yields null.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const logger = require('../services/logger');
const { currentRestrictionPolicy, resolveRestrictionCounty, DEFAULT_POLICY, _private } = require('../config/irrigation-restrictions');

const IN_FORCE = new Date('2026-08-28T12:00:00Z');
const AFTER = new Date('2026-10-02T12:00:00Z');

describe('currentRestrictionPolicy', () => {
  beforeEach(() => { logger.error.mockClear(); _private._lastLogged.clear(); });

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
    // Once per hour per message, not once per customer / report load.
    currentRestrictionPolicy(AFTER, { env: {}, county: 'Manatee' });
    currentRestrictionPolicy(AFTER, { env: {}, county: 'Sarasota' });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  test('a policy that expires inside the plan week does not cover it → null (the week before 10-01 sends no plan without a successor)', () => {
    // Plan week Mon 09-28 → Sun 10-04 straddles the 10-01 expiry.
    expect(currentRestrictionPolicy(new Date('2026-09-28T12:00:00Z'), { env: {}, county: 'Manatee', horizonEnd: '2026-10-04' })).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('inside the plan week ending 2026-10-04'));
    // The week fully inside the order is fine.
    expect(currentRestrictionPolicy(new Date('2026-09-21T12:00:00Z'), { env: {}, county: 'Manatee', horizonEnd: '2026-09-27' })).toMatchObject({ maxDaysPerWeek: 1 });
    // A successor policy covering the horizon restores plans.
    const env = { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, effectiveFrom: '2026-09-28', expiresOn: '2027-12-31', label: 'successor', coverage: 'all', hoursNote: 'before 10 a.m. or after 4 p.m.' }) };
    expect(currentRestrictionPolicy(new Date('2026-09-28T12:00:00Z'), { env, county: 'Manatee', horizonEnd: '2026-10-04' })).toMatchObject({ maxDaysPerWeek: 2 });
    // gh-r24: a policy that does not state its hours is rejected unless it explicitly asserts none.
    const silent = { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, effectiveFrom: '2026-09-28', expiresOn: '2027-12-31', label: 'successor', coverage: 'all' }) };
    expect(currentRestrictionPolicy(new Date('2026-09-28T12:00:00Z'), { env: silent, county: 'Manatee', horizonEnd: '2026-10-04' })).toBeNull();
    const noHours = { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, effectiveFrom: '2026-09-28', expiresOn: '2027-12-31', label: 'successor', coverage: 'all', noHourRestriction: true }) };
    expect(currentRestrictionPolicy(new Date('2026-09-28T12:00:00Z'), { env: noHours, county: 'Manatee', horizonEnd: '2026-10-04' })).toMatchObject({ maxDaysPerWeek: 2 });
  });

  test('IRRIGATION_RESTRICTION_POLICY env JSON overrides the default', () => {
    const env = { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, effectiveFrom: '2026-10-02', expiresOn: '2027-12-31', label: 'SWFWMD year-round rule', hoursNote: 'before 10 a.m. or after 4 p.m.', coverage: { counties: ['Manatee', 'Sarasota'], partial: ['Charlotte'] } }) };
    expect(currentRestrictionPolicy(AFTER, { env, county: 'Manatee' })).toMatchObject({ maxDaysPerWeek: 2, label: 'SWFWMD year-round rule' });
    // Not yet effective → null (no fallback to the default either).
    expect(currentRestrictionPolicy(IN_FORCE, { env, county: 'Manatee' })).toBeNull();
  });

  test('malformed env policy → null (fail closed), never the default', () => {
    expect(currentRestrictionPolicy(IN_FORCE, { env: { IRRIGATION_RESTRICTION_POLICY: '{not json' }, county: 'Manatee' })).toBeNull(); // configured-but-unusable ≠ unset
    expect(currentRestrictionPolicy(IN_FORCE, { env: { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 9, expiresOn: '2027-01-01', coverage: 'all' }) }, county: 'Manatee' })).toBeNull();
    expect(currentRestrictionPolicy(IN_FORCE, { env: { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, expiresOn: 'soon', coverage: 'all' }) }, county: 'Manatee' })).toBeNull();
    // Shape-valid but not a real date, and an inverted range: both fail closed.
    expect(currentRestrictionPolicy(IN_FORCE, { env: { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, expiresOn: '2026-02-31', coverage: 'all' }) }, county: 'Manatee' })).toBeNull();
    expect(currentRestrictionPolicy(IN_FORCE, { env: { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, expiresOn: '2026-99-99', coverage: 'all' }) }, county: 'Manatee' })).toBeNull();
    expect(currentRestrictionPolicy(IN_FORCE, { env: { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, effectiveFrom: '2026-12-01', expiresOn: '2026-09-01', coverage: 'all' }) }, county: 'Manatee' })).toBeNull();
  });
});

describe('jurisdiction', () => {
  test('the default order applies in Manatee and Sarasota; partial Charlotte and unknown county → no policy (fail closed)', () => {
    expect(currentRestrictionPolicy(IN_FORCE, { env: {}, county: 'Sarasota' })).toMatchObject({ maxDaysPerWeek: 1, county: 'Sarasota' });
    expect(currentRestrictionPolicy(IN_FORCE, { env: {}, county: 'Charlotte' })).toBeNull();
    expect(currentRestrictionPolicy(IN_FORCE, { env: {}, county: 'Hillsborough' })).toBeNull();
    expect(currentRestrictionPolicy(IN_FORCE, { env: {} })).toBeNull();
  });

  test('an env policy MUST declare coverage — none → invalid → null; the explicit all marker still needs a known county', () => {
    const none = { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, expiresOn: '2027-12-31', label: 'year-round' }) };
    expect(currentRestrictionPolicy(IN_FORCE, { env: none, county: 'Manatee' })).toBeNull();
    const all = { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysWeek: 2, maxDaysPerWeek: 2, expiresOn: '2027-12-31', label: 'year-round', coverage: 'all', hoursNote: 'before 10 a.m. or after 4 p.m.' }) };
    expect(currentRestrictionPolicy(IN_FORCE, { env: all, county: 'Charlotte' })).toMatchObject({ maxDaysPerWeek: 2 });
    expect(currentRestrictionPolicy(IN_FORCE, { env: all })).toBeNull();
    const listed = { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, expiresOn: '2027-12-31', label: 'x', coverage: { counties: ['Manatee'], partial: ['Charlotte'] }, hoursNote: 'before 10 a.m. or after 4 p.m.' }) };
    expect(currentRestrictionPolicy(IN_FORCE, { env: listed, county: 'Charlotte' })).toBeNull();
    expect(currentRestrictionPolicy(IN_FORCE, { env: listed, county: 'Manatee' })).toMatchObject({ maxDaysPerWeek: 2 });
  });

  test('resolveRestrictionCounty: turf-profile county first, then whole-county service cities, else null', () => {
    expect(resolveRestrictionCounty({ county: 'sarasota county', city: 'Sarasota' })).toBe('Sarasota'); // normalized
    expect(resolveRestrictionCounty({ county: 'sarasota county', city: 'Bradenton' })).toBe('Manatee'); // conflicting current city wins
    expect(resolveRestrictionCounty({ city: 'Lakewood Ranch' })).toBeNull(); // straddles Manatee/Sarasota
    // ZIP outranks the USPS city: "Sarasota" at 34243 is Manatee County; a Lakewood Ranch ZIP resolves too.
    expect(resolveRestrictionCounty({ city: 'Sarasota', zip: '34243' })).toBe('Manatee');
    expect(resolveRestrictionCounty({ city: 'Lakewood Ranch', zip: '34202' })).toBe('Manatee');
    expect(resolveRestrictionCounty({ city: 'Lakewood Ranch', zip: '34240' })).toBe('Sarasota');
    expect(resolveRestrictionCounty({ county: 'Sarasota', zip: '34243' })).toBe('Manatee'); // stale profile vs current ZIP
    expect(resolveRestrictionCounty({ city: 'Parrish' })).toBe('Manatee');
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

describe('resolveRestrictionCounty covers the whole service area (codex gh-r29)', () => {
  const { resolveRestrictionCounty } = require('../config/irrigation-restrictions');
  const { SERVICE_AREA_COUNTY_ZIPS } = require('../config/county-zips');
  test('a service-area ZIP the tax map omits (Cortez 34215) still resolves; the tax map stays authoritative where it speaks', () => {
    expect(resolveRestrictionCounty({ zip: '34215' })).toBe('Manatee');
    expect(resolveRestrictionCounty({ zip: '34216', city: 'Anna Maria' })).toBe('Manatee');
    expect(resolveRestrictionCounty({ zip: '34243', city: 'Sarasota' })).toBe('Manatee'); // tax map
    expect(SERVICE_AREA_COUNTY_ZIPS.Manatee).toContain('34215');
  });
  test('a ZIP shared across county lines never decides jurisdiction on its own (city map / fail closed)', () => {
    // 34223 (Englewood) sits in both the Sarasota and Charlotte service-area sets and not in the tax map.
    expect(resolveRestrictionCounty({ zip: '34223', city: 'Englewood' })).toBe(null);
    expect(resolveRestrictionCounty({ zip: '34223', city: 'Venice' })).toBe('Sarasota'); // whole-county city map
  });
});

describe('resolveRestrictionCounty after a KNOWN move (hook P1 on ad0b1ed31)', () => {
  const { resolveRestrictionCounty } = require('../config/irrigation-restrictions');
  test('the old profile county is rejected unless the profile describes the current home; ambiguous new address → null (fail closed)', () => {
    // Old Sarasota profile (no municipality), new address Englewood 34223 (Sarasota/Charlotte shared) → null.
    expect(resolveRestrictionCounty({ county: 'Sarasota', profileCity: null, city: 'Englewood', zip: '34223', homeMoved: true })).toBe(null);
    // Same inputs without a move keep today's behavior (profile county stands).
    expect(resolveRestrictionCounty({ county: 'Sarasota', profileCity: null, city: 'Englewood', zip: '34223' })).toBe('Sarasota');
    // The current address establishing the county wins after a move.
    expect(resolveRestrictionCounty({ county: 'Sarasota', profileCity: null, city: 'Bradenton', zip: '34205', homeMoved: true })).toBe('Manatee');
    // A profile re-written for the current home (city matches) is trusted again.
    expect(resolveRestrictionCounty({ county: 'Charlotte', profileCity: 'Englewood', city: 'Englewood', zip: '34223', homeMoved: true })).toBe('Charlotte');
  });
});
