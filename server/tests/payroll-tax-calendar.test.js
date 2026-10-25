// Payroll tax calendar (layer 2): the holiday sets, the due-date roll rules and
// the obligations worked out from finalized checks. Pure; all names synthetic.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  NEW_HIRE_FLOOR, legalHolidaysIrs, legalHolidaysFlorida, rollIrs, rollFlorida, payrollObligations, withBalances,
} = require('../services/payroll-tax-calendar');

let nextId = 0;
const check = (payDate, patch = {}) => ({
  id: `check-${nextId += 1}`,
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

  test('FUTA over $500 makes one alert row on the first crossing quarter; the 940 holds the full year', () => {
    const rows = payrollObligations({
      checks: [
        check('2027-02-05', { futa_cents: 30000 }),
        check('2027-05-07', { futa_cents: 30000 }), // cumulative 600.00 through Q2
        check('2027-08-06', { futa_cents: 40000 }), // still over, but the alert is once a year
      ],
      hires: [],
      today: '2027-09-01',
    });
    const map = byKey(rows);
    const alerts = rows.filter((r) => r.filing_type === 'payroll_futa_alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      source_key: 'payroll:futa_over_500:2027',
      title: 'FUTA passed $500 — deposit due (Q2 2027)',
      period_label: 'Tax Year 2027',
      due_date: '2027-08-02', // Jul 31 is a Saturday
      amount_due: null,
    });
    expect(alerts[0].notes).toContain('passed $500 in Q2');
    expect(alerts[0].notes).toContain('check the amount with your accountant');
    expect(rows.some((r) => r.filing_type === 'payroll_futa_deposit')).toBe(false);
    expect(map['payroll:940:2027']).toMatchObject({
      period_label: 'Tax Year 2027', due_date: '2028-01-31', amount_due: '1000.00',
    });
    expect(map['payroll:w2:2027']).toMatchObject({ filing_type: 'payroll_w2', due_date: '2028-01-31', amount_due: null });
  });

  test('FUTA at or under $500 for the year: no alert row, the 940 holds it all', () => {
    const map = byKey(payrollObligations({
      checks: [check('2027-02-05', { futa_cents: 50000 })], hires: [], today: '2027-03-01',
    }));
    expect(Object.keys(map).some((k) => k.includes('futa'))).toBe(false);
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

describe('withBalances', () => {
  const deposit = (amount) => ({
    source_key: 'payroll:941_deposit:2027-01', filing_type: 'payroll_941_deposit', title: 'Federal payroll tax deposit — Jan 2027',
    period_label: 'Jan 2027', due_date: '2027-02-16', amount_due: amount, notes: 'Pay on EFTPS.',
  });
  const marked = (key, patch) => ({ source_key: key, amount_paid: null, amount_due: null, ...patch });
  const BASE = 'payroll:941_deposit:2027-01';

  test('no marked row: the base row is wanted as is', () => {
    expect(withBalances([deposit('600.00')], [])).toEqual([deposit('600.00')]);
  });

  test('paid $600 and the liability is now $700: one balance row for $100', () => {
    const rows = withBalances([deposit('700.00')], [marked(BASE, { amount_paid: '600.00', amount_due: '600.00' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_key: `${BASE}:balance:1`, filing_type: 'payroll_941_deposit', period_label: 'Jan 2027',
      due_date: '2027-02-16', amount_due: '100.00', title: 'Federal payroll tax deposit — Jan 2027 — balance after a correction',
    });
    expect(rows[0].notes).toBe('Pay on EFTPS. A pay run changed after this was marked done; $100.00 more is due. A corrected return may be needed.');
  });

  test('the liability fell to the amount paid or below: no row', () => {
    const paid = [marked(BASE, { amount_paid: '600.00', amount_due: '600.00' })];
    expect(withBalances([deposit('600.00')], paid)).toEqual([]);
    expect(withBalances([deposit('500.00')], paid)).toEqual([]);
  });

  test('two marked rows and the liability up again: balance 2 holds what is still uncovered', () => {
    const rows = withBalances([deposit('750.00')], [
      marked(BASE, { amount_paid: '600.00', amount_due: '600.00' }),
      marked(`${BASE}:balance:1`, { amount_paid: '100.00', amount_due: '100.00' }),
    ]);
    expect(rows.map((r) => [r.source_key, r.amount_due])).toEqual([[`${BASE}:balance:2`, '50.00']]);
  });

  test('amount_paid wins over amount_due; a prepared row counts its amount_due as covered', () => {
    const prepared = withBalances([deposit('700.00')], [marked(BASE, { amount_due: '650.00' })]);
    expect(prepared[0]).toMatchObject({ source_key: `${BASE}:balance:1`, amount_due: '50.00' });
    const paidLess = withBalances([deposit('700.00')], [marked(BASE, { amount_paid: '640.00', amount_due: '700.00' })]);
    expect(paidLess[0].amount_due).toBe('60.00');
  });

  test('a marked row with no amount on the duty (return, W-2, new hire, alert) wants nothing', () => {
    const ret = { ...deposit(null), source_key: 'payroll:941:2027-Q1', filing_type: 'payroll_941' };
    expect(withBalances([ret], [marked('payroll:941:2027-Q1', { amount_paid: null })])).toEqual([]);
    expect(withBalances([ret], [])).toEqual([ret]);
  });

  test('an unrelated marked row does not hide another duty', () => {
    const feb = { ...deposit('300.00'), source_key: 'payroll:941_deposit:2027-02' };
    expect(withBalances([feb], [marked(BASE, { amount_paid: '600.00' })])).toEqual([feb]);
  });
});

describe('source digest and review rows', () => {
  const Q1_941 = 'payroll:941:2027-Q1';
  const obsFor = (checks) => byKey(payrollObligations({ checks, hires: [], today: '2027-03-01' }));
  const first = [check('2027-01-08'), check('2027-02-05')];
  const marked = (key, source_digest, patch = {}) => ({ source_key: key, source_digest, amount_paid: null, amount_due: null, ...patch });
  const reviewsOf = (rows) => rows.filter((r) => r.source_key.includes(':review:'));

  test('rows built from checks carry a digest of exactly those checks; hire and alert rows carry none', () => {
    const a = obsFor(first);
    expect(a[Q1_941].source_digest).toMatch(/^[0-9a-f]{32}$/);
    expect(a[Q1_941].source_digest).toBe(a['payroll:rt6:2027-Q1'].source_digest);
    expect(a['payroll:941_deposit:2027-01'].source_digest).not.toBe(a['payroll:941_deposit:2027-02'].source_digest);
    expect(a['payroll:w2:2027'].source_digest).toBe(a['payroll:940:2027'].source_digest);
    expect(obsFor([...first].reverse())[Q1_941].source_digest).toBe(a[Q1_941].source_digest);
    const hire = payrollObligations({
      checks: [], today: '2026-11-01', hires: [{ id: 't1', name: 'Sample Employee', employment_type: 'w2', hire_date: '2026-11-01' }],
    });
    expect(hire[0].source_digest).toBeNull();
    const alert = payrollObligations({ checks: [check('2027-01-08', { futa_cents: 60000 })], hires: [], today: '2027-03-01' })
      .find((r) => r.filing_type === 'payroll_futa_alert');
    expect(alert.source_digest).toBeNull();
  });

  test('the same figures on a replacement check (new id) or a changed figure change the digest', () => {
    const base = obsFor(first)[Q1_941].source_digest;
    expect(obsFor([check('2027-01-08'), first[1]])[Q1_941].source_digest).not.toBe(base);
    expect(obsFor([{ ...first[0], gross_cents: 1 }, first[1]])[Q1_941].source_digest).not.toBe(base);
  });

  test('a marked 941 with changed checks gets one review row; unchanged checks get none', () => {
    const old = obsFor(first)[Q1_941];
    const now = payrollObligations({ checks: [check('2027-01-08'), first[1]], hires: [], today: '2027-03-01' });
    const rows = withBalances(now, [marked(Q1_941, old.source_digest, { status: 'filed' })]);
    const reviews = reviewsOf(rows);
    expect(reviews).toHaveLength(1);
    const current = now.find((r) => r.source_key === Q1_941).source_digest;
    expect(reviews[0]).toMatchObject({
      source_key: `${Q1_941}:review:1`,
      filing_type: 'payroll_941',
      period_label: 'Q1 2027',
      title: 'Form 941 — Q1 2027 — figures changed after it was marked done',
      amount_due: null,
      source_digest: current,
    });
    expect(reviews[0].notes).toContain('941-X, RT-8A, amended 940 or W-2c');
    const same = payrollObligations({ checks: first, hires: [], today: '2027-03-01' });
    expect(reviewsOf(withBalances(same, [marked(Q1_941, old.source_digest)]))).toEqual([]);
  });

  test('a marked review row holding the current digest ends the ask; a second change makes review 2', () => {
    const v1 = obsFor(first)[Q1_941].source_digest;
    const secondChecks = [check('2027-01-08'), first[1]];
    const v2 = obsFor(secondChecks)[Q1_941];
    const done = [marked(Q1_941, v1), marked(`${Q1_941}:review:1`, v2.source_digest)];
    const now2 = payrollObligations({ checks: secondChecks, hires: [], today: '2027-03-01' });
    expect(reviewsOf(withBalances(now2, done))).toEqual([]);
    const now3 = payrollObligations({ checks: [check('2027-01-08'), secondChecks[1]], hires: [], today: '2027-03-01' });
    const reviews = reviewsOf(withBalances(now3, done));
    expect(reviews.map((r) => r.source_key)).toEqual([`${Q1_941}:review:2`]);
    expect(reviews[0].source_digest).toBe(now3.find((r) => r.source_key === Q1_941).source_digest);
  });

  test('compares with the latest acknowledged state: A filed, A+B acknowledged, B voided (back to A) raises review 2', () => {
    const A = [check('2027-01-08')];
    const AB = [...A, check('2027-02-05')];
    const digestOf = (checks) => payrollObligations({ checks, hires: [], today: '2027-03-01' }).find((r) => r.source_key === Q1_941).source_digest;
    const obsOf = (checks) => payrollObligations({ checks, hires: [], today: '2027-03-01' });
    const dA = digestOf(A);
    const dAB = digestOf(AB);
    const dC = digestOf([...AB, check('2027-02-12')]);
    expect(new Set([dA, dAB, dC]).size).toBe(3);
    const base = marked(Q1_941, dA, { updated_at: '2027-01-01' });
    const rev1 = marked(`${Q1_941}:review:1`, dAB);
    // Back to A: the base row's digest matches, but the latest acknowledged state is review 1.
    expect(reviewsOf(withBalances(obsOf(A), [base, rev1])).map((r) => r.source_key)).toEqual([`${Q1_941}:review:2`]);
    // Review 2 acknowledged with A and staying at A: nothing.
    const rev2 = marked(`${Q1_941}:review:2`, dA);
    expect(reviewsOf(withBalances(obsOf(A), [base, rev1, rev2]))).toEqual([]);
    // A change to C: review 3.
    expect(reviewsOf(withBalances(obsOf([...AB, check('2027-02-12')]), [base, rev1, rev2])).map((r) => r.source_key))
      .toEqual([`${Q1_941}:review:3`]);
    // Order comes from the key number, not from a timestamp: an edit to the base row changes nothing.
    const editedBase = { ...base, updated_at: '2030-01-01' };
    expect(reviewsOf(withBalances(obsOf(A), [editedBase, rev1, rev2]))).toEqual([]);
    expect(reviewsOf(withBalances(obsOf(A), [editedBase, rev1])).map((r) => r.source_key)).toEqual([`${Q1_941}:review:2`]);
    // The row order given to the helper does not matter either.
    expect(reviewsOf(withBalances(obsOf(A), [rev2, rev1, base]))).toEqual([]);
  });

  test('a marked row with no digest (not written by this sync) gets no review row', () => {
    const now = payrollObligations({ checks: first, hires: [], today: '2027-03-01' });
    expect(reviewsOf(withBalances(now, [marked(Q1_941, null)]))).toEqual([]);
  });

  test('a deposit is money only: a changed digest with the same amount adds no row', () => {
    const key = 'payroll:941_deposit:2027-01';
    const now = payrollObligations({ checks: [check('2027-01-08')], hires: [], today: '2027-01-20' });
    const dep = now.find((r) => r.source_key === key);
    expect(withBalances(now, [marked(key, 'old-digest', { amount_paid: dep.amount_due })]).filter((r) => r.source_key.startsWith(key))).toEqual([]);
  });

  test('RT-6 and Form 940 can get a balance row and a review row together', () => {
    const now = payrollObligations({ checks: [check('2027-01-08', { fl_reemployment_cents: 5000 })], hires: [], today: '2027-03-01' });
    const rows = withBalances(now, [marked('payroll:rt6:2027-Q1', 'old-digest', { amount_paid: '1.00', amount_due: '1.00' })]);
    const keys = rows.map((r) => r.source_key).filter((k) => k.startsWith('payroll:rt6:2027-Q1'));
    expect(keys.some((k) => k.includes(':review:'))).toBe(true);
    expect(keys).toContain('payroll:rt6:2027-Q1:balance:1');
  });

  test('a payment on a balance row does not acknowledge a review', () => {
    const now = payrollObligations({ checks: [check('2027-01-08', { fl_reemployment_cents: 5000 })], hires: [], today: '2027-03-01' });
    const current = now.find((r) => r.source_key === 'payroll:rt6:2027-Q1').source_digest;
    const rows = withBalances(now, [
      marked('payroll:rt6:2027-Q1', 'old-digest', { amount_paid: '1.00', amount_due: '1.00' }),
      marked('payroll:rt6:2027-Q1:balance:1', current, { amount_paid: '49.00', amount_due: '49.00' }),
    ]);
    expect(reviewsOf(rows).map((r) => r.source_key)).toEqual(['payroll:rt6:2027-Q1:review:1']);
  });
});

describe('periods with every check voided', () => {
  const EMPTY = obsEmpty();
  function obsEmpty() {
    // The digest of the empty set, as the sync computes it for a period with no checks.
    const rows = payrollObligations({ checks: [], hires: [], today: '2027-02-01', remembered: ['payroll:941:2027-Q1'] });
    return rows.find((r) => r.source_key === 'payroll:941:2027-Q1').source_digest;
  }
  const marked = (key, source_digest, patch = {}) => ({ source_key: key, source_digest, amount_paid: null, amount_due: null, ...patch });
  const reviewsOf = (rows) => rows.filter((r) => r.source_key.includes(':review:'));

  test('no checks and nothing marked: no rows', () => {
    expect(payrollObligations({ checks: [], hires: [], today: '2027-02-01', remembered: [] })).toEqual([]);
  });

  test('a marked 941 whose quarter lost every check gets a review row with the empty-set digest', () => {
    const now = payrollObligations({ checks: [], hires: [], today: '2027-02-01', remembered: ['payroll:941:2027-Q1'] });
    expect(EMPTY).toMatch(/^[0-9a-f]{32}$/);
    const rows = withBalances(now, [marked('payroll:941:2027-Q1', 'old-digest')]);
    expect(reviewsOf(rows).map((r) => r.source_key)).toEqual(['payroll:941:2027-Q1:review:1']);
    // The span still runs to the quarter holding today and starts at the remembered quarter.
    expect(now.map((r) => r.source_key).filter((k) => k.startsWith('payroll:rt6:'))).toEqual(['payroll:rt6:2027-Q1']);
  });

  test('a remembered quarter before the first check starts the span there', () => {
    const now = payrollObligations({
      checks: [check('2027-05-07')], hires: [], today: '2027-05-10', remembered: ['payroll:rt6:2027-Q1:review:2'],
    });
    expect(now.map((r) => r.source_key).filter((k) => k.startsWith('payroll:941:'))).toEqual(['payroll:941:2027-Q1', 'payroll:941:2027-Q2']);
  });

  test('a marked W-2 whose year lost every check gets a review row; the 940 holds zero', () => {
    const now = payrollObligations({ checks: [], hires: [], today: '2027-02-01', remembered: ['payroll:w2:2026'] });
    const keys = now.map((r) => r.source_key);
    expect(keys).toEqual(expect.arrayContaining(['payroll:w2:2026', 'payroll:940:2026']));
    expect(now.find((r) => r.source_key === 'payroll:940:2026').amount_due).toBe('0.00');
    expect(keys.some((k) => k.includes('futa_over_500'))).toBe(false);
    const rows = withBalances(now, [marked('payroll:w2:2026', 'old-digest')]);
    expect(reviewsOf(rows).map((r) => r.source_key)).toEqual(['payroll:w2:2026:review:1']);
  });

  test('a paid deposit whose month lost every check wants no row', () => {
    const key = 'payroll:941_deposit:2027-01';
    const now = payrollObligations({ checks: [], hires: [], today: '2027-01-20', remembered: [key] });
    const dep = now.find((r) => r.source_key === key);
    expect(dep.amount_due).toBe('0.00');
    expect(withBalances(now, [marked(key, 'old-digest', { amount_paid: '253.00', amount_due: '253.00' })])
      .filter((r) => r.source_key.startsWith(key))).toEqual([]);
  });

  test('balance, review and new-hire keys name their period correctly', () => {
    const now = payrollObligations({
      checks: [], hires: [], today: '2027-01-20',
      remembered: ['payroll:941_deposit:2027-01:balance:1', 'payroll:new_hire:t1', 'payroll:futa_over_500:2027', 'payroll:w2:2026:review:12'],
    });
    expect(now.map((r) => r.source_key).filter((k) => k.includes('2027-01') || k.includes('2026'))).toEqual(expect.arrayContaining(['payroll:941_deposit:2027-01', 'payroll:w2:2026']));
    expect(now.some((r) => r.source_key.includes('review') || r.source_key.includes('balance') || r.source_key.includes('new_hire'))).toBe(false);
  });
});
