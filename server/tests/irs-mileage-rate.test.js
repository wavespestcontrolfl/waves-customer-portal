/**
 * Authoritative IRS standard-business-mileage rate assertions. These feed
 * PERSISTED deductions, reports, and CSV exports, so each rate is pinned to
 * its IRS source and the resolver's date-effective behavior is locked down.
 * 2026 is a MID-YEAR split — the H1/H2 boundary is the guardrail here; a trip
 * on the wrong side of Jul 1 mis-states its deduction.
 *
 * Sources: Notice 2024-08 (67¢), Notice 2025-05 (70¢), Notice 2026-10 (72.5¢
 * from Jan 1 2026), Announcement 2026-11 / IRB 2026-29 (76¢ from Jul 1 2026,
 * superseding Notice 2026-10 for H2).
 */
const { getIrsRate } = require('../services/bouncie-mileage');

describe('IRS standard mileage rate', () => {
  test('2026 splits mid-year: 72.5¢ through Jun 30, 76¢ from Jul 1', () => {
    expect(getIrsRate('2026-01-01')).toBe(0.725);
    expect(getIrsRate('2026-06-30')).toBe(0.725); // last H1 day
    expect(getIrsRate('2026-07-01')).toBe(0.76);  // Announcement 2026-11 effective date
    expect(getIrsRate('2026-12-31')).toBe(0.76);
  });

  test('prior years match their IRS notices', () => {
    expect(getIrsRate('2024-06-15')).toBe(0.67);
    expect(getIrsRate('2025-06-15')).toBe(0.70);
  });

  test('accepts Date and bare-year inputs; bare year resolves to the OPENING rate', () => {
    expect(getIrsRate(new Date('2026-08-01T12:00:00Z'))).toBe(0.76); // H2 date → H2 rate
    expect(getIrsRate(2026)).toBe(0.725); // bare year = Jan 1 opening rate
    expect(getIrsRate(2025)).toBe(0.70);
  });

  test('FAILS CLOSED below the table floor (pre-2024 has its own uncarried rates)', () => {
    // 2023 was 65.5¢, 2022 58.5/62.5¢ — none are in the table, so reusing
    // 2024's 0.67 would be wrong. Must be 0, not 0.67.
    expect(getIrsRate('2023-12-31')).toBe(0);
    expect(getIrsRate('2020-01-01')).toBe(0);
    // First covered day is the real rate.
    expect(getIrsRate('2024-01-01')).toBe(0.67);
  });

  test('FAILS CLOSED past the verified horizon (no silent reuse of 0.76)', () => {
    // 2027 has no published rate yet — must be 0, not 2026 H2's 0.76.
    expect(getIrsRate('2027-01-01')).toBe(0);
    expect(getIrsRate('2027-08-01')).toBe(0);
    expect(getIrsRate(2027)).toBe(0);
    // The last covered day is still the real rate.
    expect(getIrsRate('2026-12-31')).toBe(0.76);
  });
});
