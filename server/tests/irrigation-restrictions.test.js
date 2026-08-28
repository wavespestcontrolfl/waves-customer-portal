/**
 * Restriction policy = the legal ceiling above the watering model. Pins the
 * fail-closed rule: past expiry with nothing newer configured there is NO
 * policy (never a silent 2-day fallback), env JSON overrides the default,
 * malformed input yields null.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const logger = require('../services/logger');
const { currentRestrictionPolicy, DEFAULT_POLICY } = require('../config/irrigation-restrictions');

const IN_FORCE = new Date('2026-08-28T12:00:00Z');
const AFTER = new Date('2026-10-02T12:00:00Z');

describe('currentRestrictionPolicy', () => {
  beforeEach(() => logger.error.mockClear());

  test('default = SWFWMD Modified Phase III, one day per week through 2026-10-01', () => {
    const p = currentRestrictionPolicy(IN_FORCE, { env: {} });
    expect(p).toMatchObject({ maxDaysPerWeek: 1, expiresOn: '2026-10-01' });
    expect(p.label).toMatch(/Phase III/);
    expect(DEFAULT_POLICY.maxDaysPerWeek).toBe(1);
  });

  test('last day of the order is still in force; the day after is NOT — null, logged', () => {
    expect(currentRestrictionPolicy(new Date('2026-10-01T23:00:00Z'), { env: {} })).not.toBeNull(); // 19:00 ET Oct 1
    expect(currentRestrictionPolicy(AFTER, { env: {} })).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('expired 2026-10-01'));
  });

  test('IRRIGATION_RESTRICTION_POLICY env JSON overrides the default', () => {
    const env = { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, effectiveFrom: '2026-10-02', expiresOn: '2027-12-31', label: 'SWFWMD year-round rule', hoursNote: 'before 10 a.m. or after 4 p.m.' }) };
    expect(currentRestrictionPolicy(AFTER, { env })).toMatchObject({ maxDaysPerWeek: 2, label: 'SWFWMD year-round rule' });
    // Not yet effective → null (no fallback to the default either).
    expect(currentRestrictionPolicy(IN_FORCE, { env })).toBeNull();
  });

  test('malformed env policy → null (fail closed), never the default', () => {
    expect(currentRestrictionPolicy(IN_FORCE, { env: { IRRIGATION_RESTRICTION_POLICY: '{not json' } })).toMatchObject({ maxDaysPerWeek: 1 }); // unparseable = ignored → default applies while in force
    expect(currentRestrictionPolicy(IN_FORCE, { env: { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 9, expiresOn: '2027-01-01' }) } })).toBeNull();
    expect(currentRestrictionPolicy(IN_FORCE, { env: { IRRIGATION_RESTRICTION_POLICY: JSON.stringify({ maxDaysPerWeek: 2, expiresOn: 'soon' }) } })).toBeNull();
  });
});
