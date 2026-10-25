// Payroll tax calendar (layer 2): the holiday sets, the due-date roll rules and
// the obligations worked out from finalized checks. Pure; all names synthetic.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  NEW_HIRE_FLOOR, legalHolidaysIrs, legalHolidaysFlorida, rollIrs, rollFlorida, payrollObligations,
} = require('../services/payroll-tax-calendar');

const check = (payDate, patch = {}) => ({
  pay_date: payDate,
  federal_income_tax_cents: 10000,
  social_security_cents: 6200,
  medicare_cents: 1450,
  additional_medicare_cents: 0,
  employer_social_security_cents: 6200,
  employer_medicare_cents: 1450,
  futa_cents: 600,
  fl_reemployment_cents: 270,
  ...patch,
});
// 10000 + 6200 + 1450 + 0 + 6200 + 1450 = 25300 cents per default check.
const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.source_key, r]));

describe('legal holidays', () => {
  test('IRS 2026 set equals Pub 509 (2026)', () => {
    expect([...legalHolidaysIrs(2026)].sort()).toEqual([
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-16', '2026-05-25', '2026-06-19',
      '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
    ]);
  });

  test('a Saturday January 1 is observed on Dec 31 of the year before', () => {
    expect(legalHolidaysIrs(2027).has('2027-12-31')).toBe(true);
    expect(legalHolidaysIrs(2028).has('2028-01-01')).toBe(false);
  });

  test('Inauguration Day: Jan 20 in the year after a leap year, Sunday moves to Monday, Saturday does not move', () => {
    expect(legalHolidaysIrs(2025).has('2025-01-20')).toBe(true);
    expect(legalHolidaysIrs(2029).has('2029-01-20')).toBe(false);
    expect(legalHolidaysIrs(2029).has('2029-01-19')).toBe(false);
    expect(legalHolidaysIrs(2013).has('2013-01-21')).toBe(true);
  });

  test('Florida set adds the Friday after Thanksgiving and drops the DC-only days', () => {
    const fl = legalHolidaysFlorida(2026);
    expect(fl.has('2026-11-27')).toBe(true);
    expect(fl.has('2026-04-16')).toBe(false);
    expect(legalHolidaysFlorida(2025).has('2025-01-20')).toBe(true); // MLK is Jan 20 in 2025
    expect(legalHolidaysFlorida(2025).size).toBe(12);
  });
});

describe('roll rules', () => {
  test('IRS dates skip weekends and DC holidays', () => {
    expect(rollIrs('2027-02-15')).toBe('2027-02-16'); // Washington's Birthday
    expect(rollIrs('2029-01-15')).toBe('2029-01-16'); // MLK
    expect(rollIrs('2028-04-15')).toBe('2028-04-18'); // Sat, Sun, Emancipation Day observed Mon
    expect(rollIrs('2027-03-15')).toBe('2027-03-15'); // Monday, no holiday
  });

  test('Florida dates skip weekends and state or federal holidays', () => {
    expect(rollFlorida('2027-01-31')).toBe('2027-02-01');
    expect(rollFlorida('2027-10-31')).toBe('2027-11-01');
    expect(rollFlorida('2027-04-30')).toBe('2027-04-30');
  });
});

describe('payrollObligations', () => {
  test('no checks and no hires: no rows', () => {
    expect(payrollObligations({ checks: [], hires: [], today: '2027-03-01' })).toEqual([]);
  });

  test('monthly deposit: two January checks and one February check', () => {
    const rows = payrollObligations({
      checks: [check('2027-01-08'), check('2027-01-22'), check('2027-02-05')],
      hires: [],
      today: '2027-02-10',
    });
    const map = byKey(rows);
    expect(map['payroll:941_deposit:2027-01']).toMatchObject({
      filing_type: 'payroll_941_deposit',
      period_label: 'Jan 2027',
      due_date: '2027-02-16',
      amount_due: '506.00',
    });
    expect(map['payroll:941_deposit:2027-02']).toMatchObject({
      period_label: 'Feb 2027', due_date: '2027-03-15', amount_due: '253.00',
    });
  });

  test('941 and RT-6 per quarter, including quarters with no checks up to today', () => {
    const rows = payrollObligations({
      checks: [check('2027-01-08'), check('2027-01-22'), check('2027-02-05')],
      hires: [],
      today: '2027-08-01',
    });
    const map = byKey(rows);
    expect(map['payroll:rt6:2027-Q1']).toMatchObject({
      filing_type: 'payroll_rt6', period_label: 'Q1 2027', due_date: '2027-04-30', amount_due: '8.10',
    });
    expect(map['payroll:941:2027-Q1']).toMatchObject({
      filing_type: 'payroll_941', due_date: '2027-04-30', amount_due: null,
    });
    expect(map['payroll:941:2027-Q1'].notes).toContain('$759.00');
    expect(map['payroll:rt6:2027-Q2']).toMatchObject({ amount_due: '0.00', due_date: '2027-08-02' });
    expect(map['payroll:941:2027-Q2']).toBeDefined();
    expect(map['payroll:rt6:2027-Q3']).toMatchObject({ amount_due: '0.00', due_date: '2027-11-01' });
    expect(map['payroll:941:2027-Q3']).toBeDefined();
    expect(map['payroll:rt6:2027-Q4']).toBeUndefined(); // after the quarter that holds today
  });

  test('FUTA over $500 makes a deposit row and lowers the Form 940 amount', () => {
    const rows = payrollObligations({
      checks: [
        check('2027-02-05', { futa_cents: 30000 }),
        check('2027-05-07', { futa_cents: 30000 }), // cumulative 600.00 through Q2
        check('2027-08-06', { futa_cents: 4000 }), // 40.00 more, under the threshold on its own
      ],
      hires: [],
      today: '2027-09-01',
    });
    const map = byKey(rows);
    expect(map['payroll:futa_deposit:2027-Q1']).toBeUndefined();
    expect(map['payroll:futa_deposit:2027-Q2']).toMatchObject({
      filing_type: 'payroll_futa_deposit', amount_due: '600.00', due_date: '2027-08-02',
    });
    expect(map['payroll:futa_deposit:2027-Q3']).toBeUndefined();
    expect(map['payroll:940:2027']).toMatchObject({
      period_label: 'Tax Year 2027', due_date: '2028-01-31', amount_due: '40.00',
    });
    expect(map['payroll:w2:2027']).toMatchObject({ filing_type: 'payroll_w2', due_date: '2028-01-31', amount_due: null });
  });

  test('FUTA at or under $500 for the year: no deposit row, the 940 holds it all', () => {
    const map = byKey(payrollObligations({
      checks: [check('2027-02-05', { futa_cents: 50000 })], hires: [], today: '2027-03-01',
    }));
    expect(Object.keys(map).some((k) => k.includes('futa_deposit'))).toBe(false);
    expect(map['payroll:940:2027'].amount_due).toBe('500.00');
  });

  test('new hire: due 20 days after hire; earlier hires, non-W-2 and prospective people get none', () => {
    const rows = payrollObligations({
      checks: [],
      hires: [
        { id: 't-new', name: 'Sample Employee', employment_type: 'w2', hire_date: '2026-11-02' },
        { id: 't-floor', name: 'Floor Employee', employment_type: 'w2', hire_date: NEW_HIRE_FLOOR },
        { id: 't-old', name: 'Old Employee', employment_type: 'w2', hire_date: '2026-10-24' },
        { id: 't-contractor', name: 'Contract Person', employment_type: '1099', hire_date: '2026-11-03' },
        { id: 't-none', name: 'No Date', employment_type: 'w2', hire_date: null },
        { id: 't-prospect', name: 'Sample Candidate', employment_type: 'w2', employment_status: 'prospective', hire_date: '2026-11-09' },
      ],
      today: '2026-11-05',
    });
    expect(rows.map((r) => r.source_key)).toEqual(['payroll:new_hire:t-floor', 'payroll:new_hire:t-new']);
    const hire = byKey(rows)['payroll:new_hire:t-new'];
    expect(hire).toMatchObject({
      filing_type: 'payroll_new_hire', due_date: '2026-11-22', period_label: 'Hired 2026-11-02', amount_due: null,
    });
    expect(hire.title).toBe('Florida new hire report — Sample Employee');
    expect(byKey(rows)['payroll:new_hire:t-floor'].due_date).toBe('2026-11-14');
  });

  test('rows are sorted by due date', () => {
    const rows = payrollObligations({ checks: [check('2027-01-08')], hires: [], today: '2027-01-20' });
    const dates = rows.map((r) => r.due_date);
    expect(dates).toEqual([...dates].sort());
  });
});
