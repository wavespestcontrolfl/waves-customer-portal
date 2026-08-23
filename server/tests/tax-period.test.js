const { taxPeriodFor } = require('../utils/tax-period');

describe('taxPeriodFor', () => {
  test.each([
    ['2026-01-01', '2026', 'Q1'],
    ['2026-03-31', '2026', 'Q1'],
    ['2026-04-01', '2026', 'Q2'],
    ['2026-06-30', '2026', 'Q2'],
    ['2026-07-01', '2026', 'Q3'],
    ['2026-10-01', '2026', 'Q4'],
    ['2026-12-31', '2026', 'Q4'],
  ])('%s → %s %s', (d, y, q) => {
    expect(taxPeriodFor(d)).toEqual({ tax_year: y, quarter: q });
  });

  test('derives from the calendar string, not local/UTC Date parsing', () => {
    // new Date('2026-01-01') is UTC midnight → Dec 31 in ET; the helper must not shift.
    expect(taxPeriodFor('2026-01-01')).toEqual({ tax_year: '2026', quarter: 'Q1' });
    expect(taxPeriodFor('2025-12-31T23:30:00.000Z')).toEqual({ tax_year: '2025', quarter: 'Q4' });
  });

  test('Date objects use the ET calendar day', () => {
    // 2026-01-01T03:00Z is still Dec 31 in ET.
    expect(taxPeriodFor(new Date('2026-01-01T03:00:00Z'))).toEqual({ tax_year: '2025', quarter: 'Q4' });
  });

  test('leap days: real ones pass, fake ones are rejected', () => {
    expect(taxPeriodFor('2024-02-29')).toEqual({ tax_year: '2024', quarter: 'Q1' });
    expect(taxPeriodFor('2023-02-29')).toBeNull();
  });

  test.each([undefined, null, '', 'not-a-date', '2026-13-01', '2026-00-10', '2026-02-31', '2026-01-01garbage', '2026-01-01 10:00', 42, new Date('nope')])(
    'invalid %p → null', (v) => { expect(taxPeriodFor(v)).toBeNull(); },
  );
});
