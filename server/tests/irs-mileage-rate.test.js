/**
 * Authoritative IRS standard-business-mileage rate assertions. These feed
 * PERSISTED deductions, reports, and CSV exports, so each rate is pinned to
 * its IRS source and the resolver's date-effective behavior is locked down.
 * A fabricated "July 1, 2026 → 76¢" entry once overstated every H2 2026
 * deduction; the 2026 test below is the guardrail against that regressing.
 *
 * Sources: Notice 2024-08 (67¢), Notice 2025-05 (70¢), Notice 2026-10 (72.5¢,
 * a SINGLE rate for all of 2026 — no mid-year increase).
 */
const { getIrsRate } = require('../services/bouncie-mileage');

describe('IRS standard mileage rate', () => {
  test('2026 is a single 72.5¢ rate for the WHOLE year (no July increase)', () => {
    expect(getIrsRate('2026-01-01')).toBe(0.725);
    expect(getIrsRate('2026-06-30')).toBe(0.725);
    expect(getIrsRate('2026-07-01')).toBe(0.725); // the fabricated 76¢ split must stay gone
    expect(getIrsRate('2026-12-31')).toBe(0.725);
  });

  test('prior years match their IRS notices', () => {
    expect(getIrsRate('2024-06-15')).toBe(0.67);
    expect(getIrsRate('2025-06-15')).toBe(0.70);
  });

  test('accepts Date and bare-year inputs, resolving to the opening rate', () => {
    expect(getIrsRate(new Date('2026-08-01T12:00:00Z'))).toBe(0.725);
    expect(getIrsRate(2026)).toBe(0.725);
    expect(getIrsRate(2025)).toBe(0.70);
  });

  test('dates before the table floor resolve to the earliest known rate', () => {
    expect(getIrsRate('2020-01-01')).toBe(0.67);
  });
});
