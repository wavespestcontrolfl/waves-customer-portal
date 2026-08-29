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
    // ZIP outranks the USPS city: a Lakewood Ranch ZIP resolves even though the city straddles.
    expect(resolveRestrictionCounty({ city: 'Lakewood Ranch', zip: '34202' })).toBe('Manatee');
    expect(resolveRestrictionCounty({ city: 'Lakewood Ranch', zip: '34240' })).toBe('Sarasota');
    // gh-r33: 34243 straddles Manatee/Sarasota (service-area map lists it under both) — neither the tax map
    // nor the USPS city "Sarasota" may decide it; the technician's profile county does, else no plan.
    expect(resolveRestrictionCounty({ city: 'Sarasota', zip: '34243' })).toBe(null);
    expect(resolveRestrictionCounty({ county: 'Manatee', zip: '34243', city: 'Sarasota' })).toBe('Manatee');
    expect(resolveRestrictionCounty({ county: 'Sarasota', zip: '34243' })).toBe('Sarasota');
    expect(resolveRestrictionCounty({ county: 'Sarasota', zip: '34205' })).toBe('Manatee'); // stale profile vs an unambiguous current ZIP
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
  test('a service-area ZIP the tax map omits (Cortez 34215) still resolves; the tax map speaks first for unshared ZIPs', () => {
    expect(resolveRestrictionCounty({ zip: '34215' })).toBe('Manatee');
    expect(resolveRestrictionCounty({ zip: '34216', city: 'Anna Maria' })).toBe('Manatee');
    expect(resolveRestrictionCounty({ zip: '34205', city: 'Sarasota' })).toBe('Manatee'); // tax map over a contradicting city
    expect(SERVICE_AREA_COUNTY_ZIPS.Manatee).toContain('34215');
  });
  test('a ZIP shared across county lines is decided by NO address-level source — tax map and city map included (codex gh-r29/r33)', () => {
    // 34223 (Englewood) sits in both the Sarasota and Charlotte service-area sets and not in the tax map.
    expect(resolveRestrictionCounty({ zip: '34223', city: 'Englewood' })).toBe(null);
    expect(resolveRestrictionCounty({ zip: '34223', city: 'Venice' })).toBe(null); // the city cannot rescue a straddling ZIP
    // 34228 (Longboat Key) files as Sarasota in the tax map but its north end is Manatee's: the tax shortcut must not force it.
    expect(SERVICE_AREA_COUNTY_ZIPS.Manatee).toContain('34228');
    expect(SERVICE_AREA_COUNTY_ZIPS.Sarasota).toContain('34228');
    expect(resolveRestrictionCounty({ zip: '34228', city: 'Longboat Key' })).toBe(null);
    expect(resolveRestrictionCounty({ zip: '34228', city: 'Sarasota' })).toBe(null);
    expect(resolveRestrictionCounty({ county: 'Manatee', zip: '34228', city: 'Longboat Key' })).toBe('Manatee'); // technician's profile county
    // Every shared service-area ZIP behaves the same way.
    const counts = {};
    for (const zips of Object.values(SERVICE_AREA_COUNTY_ZIPS)) for (const z of zips) counts[z] = (counts[z] || 0) + 1;
    for (const [z, n] of Object.entries(counts)) if (n > 1) expect(resolveRestrictionCounty({ zip: z, city: 'Sarasota' })).toBe(null);
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
    // gh-r31: a matching city is NOT proof the profile was rewritten (Englewood straddles the line) → null…
    expect(resolveRestrictionCounty({ county: 'Sarasota', profileCity: 'Englewood', city: 'Englewood', zip: '34223', homeMoved: true, movedAt: '2026-08-20T00:00:00Z' })).toBe(null);
    // gh-r32: …and neither is the profile's row-wide updated_at (an unrelated turf writer bumps it) — the
    // parameter no longer exists; only a re-saved COUNTY (ledger entry) restores trust.
    expect(resolveRestrictionCounty({ county: 'Charlotte', profileCity: 'Englewood', city: 'Englewood', zip: '34223', homeMoved: true, movedAt: '2026-08-20T00:00:00Z', profileUpdatedAt: '2026-08-25T00:00:00Z' })).toBe(null);
    expect(resolveRestrictionCounty({ county: 'Charlotte', profileCity: 'Englewood', city: 'Englewood', zip: '34223', homeMoved: true, movedAt: '2026-08-20T00:00:00Z', countyConfirmed: false })).toBe(null);
    // …a county RE-SAVED after the move is trusted again.
    expect(resolveRestrictionCounty({ county: 'Charlotte', profileCity: 'Englewood', city: 'Englewood', zip: '34223', homeMoved: true, movedAt: '2026-08-20T00:00:00Z', countyConfirmed: true })).toBe('Charlotte');
    // A confirmed county still loses to a current address that contradicts it.
    expect(resolveRestrictionCounty({ county: 'Charlotte', profileCity: 'Englewood', city: 'Bradenton', zip: '34205', homeMoved: true, countyConfirmed: true })).toBe('Manatee');
    // gh-r34: …but a STALE municipality is not a contradiction — Bradenton → Manatee side of Longboat Key 34228, county re-confirmed Manatee.
    expect(resolveRestrictionCounty({ county: 'Manatee', profileCity: 'Bradenton', city: 'Longboat Key', zip: '34228', homeMoved: true, countyConfirmed: true })).toBe('Manatee');
    expect(resolveRestrictionCounty({ county: 'Manatee', profileCity: 'Bradenton', city: 'Longboat Key', zip: '34228', homeMoved: true, countyConfirmed: false })).toBe(null);
    expect(resolveRestrictionCounty({ county: 'Manatee', profileCity: 'Bradenton', city: 'Englewood', zip: '34223', homeMoved: true, countyConfirmed: true })).toBe('Manatee');
  });
  test('the ledger entry is written only by a turf-profile save that carries a county (source contract)', () => {
    const fs = require('fs');
    const path = require('path');
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-customer-turf-profile.js'), 'utf8');
    // Same transaction as the profile upsert (the turf fence's trx), never a second one after commit (hook P1 on 45beb0731).
    expect(route).toMatch(/withTurfProfileFence\(db, customerId, async \(trx\) => \{[\s\S]*?\.returning\('\*'\);[\s\S]*?if \(countyConfirmed\) \{\s*await confirmIrrigationFields\(trx, customerId, \[COUNTY_CONFIRMED_FIELD\]\);\s*\}\s*return rows;\s*\}\);/);
    // gh-r33: an EXPLICIT review flag, never payload presence (the form re-sends every loaded field on every save).
    expect(route).toMatch(/const countyConfirmed = \(req\.body \|\| \{\}\)\.county_confirmed === true\s*&& typeof fields\.county === 'string' && !!fields\.county\.trim\(\);/);
    const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'pages', 'admin', 'LawnAssessmentPanel.jsx'), 'utf8');
    expect(panel).toMatch(/county_confirmed: countyTouched/);
    expect(panel).toMatch(/if \(key === "county"\) setCountyTouched\(true\);/);
    expect(route).not.toMatch(/confirmIrrigationFields\(db,/);
    const assessment = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-lawn-assessment.js'), 'utf8');
    expect(assessment).not.toMatch(/confirmIrrigationFields|COUNTY_CONFIRMED_FIELD/);
  });
});
