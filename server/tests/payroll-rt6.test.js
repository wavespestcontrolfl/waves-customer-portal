// RT-6 inputs of one stored check (payroll-rt6.js). A check that stored the family employee
// exemption adds nothing; a check that stored its unemployment wages uses them; a legacy row
// (no such columns) is worked out from its year-to-date as it always was.
const { rt6CheckInputs, rt6Tax } = require('../services/payroll-rt6');

const row = (patch = {}) => ({
  gross_cents: 100000, ytd_gross_before_cents: 650000, fl_reemployment_cents: 1350, calc_snapshot: {}, ...patch,
});

describe('rt6CheckInputs', () => {
  test('a legacy row is capped by its year-to-date, with or without the new columns selected', () => {
    const expected = { gross: 100000, capWages: 50000, excessWages: 50000, flReemployment: 1350, snapshot: {} };
    expect(rt6CheckInputs(row())).toEqual(expected);
    expect(rt6CheckInputs(row({ unemployment_exempt: null, unemployment_wages_cents: null }))).toEqual(expected);
  });

  test('an exempt check is all zeros, whatever its gross and year-to-date', () => {
    expect(rt6CheckInputs(row({ ytd_gross_before_cents: 0, unemployment_exempt: true, unemployment_wages_cents: '0' })))
      .toEqual({ gross: 0, capWages: 0, excessWages: 0, flReemployment: 0, snapshot: {} });
  });

  test('a check that stored its unemployment wages uses them (Postgres returns bigint as text)', () => {
    // The gross year to date says 0 left, the stored figure says $920: the stored one wins.
    const out = rt6CheckInputs(row({ ytd_gross_before_cents: 900000, unemployment_exempt: false, unemployment_wages_cents: '92000' }));
    expect(out).toMatchObject({ gross: 100000, capWages: 92000, excessWages: 8000 });
  });

  test('an exempt check adds nothing to the quarter', () => {
    const exempt = rt6CheckInputs(row({ unemployment_exempt: true, unemployment_wages_cents: 0 }));
    const normal = rt6CheckInputs(row({ ytd_gross_before_cents: 0, fl_reemployment_cents: 2700 }));
    expect(rt6Tax([exempt, normal])).toEqual(rt6Tax([normal]));
  });
});
