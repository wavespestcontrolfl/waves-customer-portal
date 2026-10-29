/**
 * Payroll bank match: the pure pairing rules (GATE_PAYROLL_BANK_MATCH). Exact cents, the pay-date
 * windows, ties, the check-number tie-break, the IRS and Florida description patterns, and the
 * rule that anything short of one check and one bank line pairing is a suggestion. All names and
 * amounts are synthetic.
 */
const {
  taxPaymentKind, checkNumbersIn, carriesCheckNumber, netPayWindow, taxWindow, filingCents,
  planNetPay, planTaxPayment, isPlausibleCheckLink, isPlausibleTaxLink,
} = require('../services/payroll-bank-match');

const check = (patch = {}) => ({
  id: 'check-a', employee_name: 'Sample Alpha', net_cents: 81263, pay_date: '2026-10-23', pay_method: 'check', check_number: null, ...patch,
});
const line = (patch = {}) => ({
  id: 'line-1', txn_date: '2026-10-28', description: 'CHECK 1042', amount: '812.63', direction: 'debit', account_type: 'bank', ...patch,
});
const filing = (patch = {}) => ({
  id: 'fil-1', source_key: 'payroll:941_deposit:2026-10', title: 'Federal payroll tax deposit - Oct 2026',
  due_date: '2026-11-16', amount_due: '350.00', amount_paid: null, ...patch,
});

describe('planNetPay', () => {
  it('links one check and one bank line at the exact cents', () => {
    const plan = planNetPay({ row: line(), checks: [check()], peers: [line()] });
    expect(plan.action).toBe('link');
    expect(plan.check.id).toBe('check-a');
  });

  it('does not link a line one cent off; it suggests the check as a near miss', () => {
    const plan = planNetPay({ row: line({ amount: '812.64' }), checks: [check()] });
    expect(plan.action).toBe('suggest');
    expect(plan.candidates).toEqual([expect.objectContaining({ id: 'check-a', nearMiss: true })]);
    expect(planNetPay({ row: line({ amount: '812.65' }), checks: [check()] }).action).toBe('none');
  });

  it('never matches a credit, a card account line, or a zero net check', () => {
    expect(planNetPay({ row: line({ direction: 'credit' }), checks: [check()] }).action).toBe('none');
    expect(planNetPay({ row: line({ account_type: 'card' }), checks: [check()] }).action).toBe('none');
    expect(planNetPay({ row: line({ amount: '0.00' }), checks: [check({ net_cents: 0 })] }).action).toBe('none');
  });

  it('uses pay date minus 3 days to plus 45 days for a paper check', () => {
    expect(netPayWindow(check())).toEqual({ from: '2026-10-20', to: '2026-12-07' });
    const at = (txn_date) => planNetPay({ row: line({ txn_date }), checks: [check()] }).action;
    expect(at('2026-10-19')).toBe('none');
    expect(at('2026-10-20')).toBe('link');
    expect(at('2026-12-07')).toBe('link');
    expect(at('2026-12-08')).toBe('none');
  });

  it('narrows a bank transfer to pay date minus 3 days to plus 7 days', () => {
    const transfer = check({ pay_method: 'bank_transfer' });
    expect(netPayWindow(transfer)).toEqual({ from: '2026-10-20', to: '2026-10-30' });
    expect(planNetPay({ row: line({ txn_date: '2026-10-30' }), checks: [transfer] }).action).toBe('link');
    expect(planNetPay({ row: line({ txn_date: '2026-10-31' }), checks: [transfer] }).action).toBe('none');
  });

  it('suggests, never links, when two checks share the amount', () => {
    const plan = planNetPay({ row: line({ description: 'ONLINE TRANSFER' }), checks: [check(), check({ id: 'check-b', employee_name: 'Sample Beta' })] });
    expect(plan.action).toBe('suggest');
    expect(plan.candidates.map((c) => c.id).sort()).toEqual(['check-a', 'check-b']);
  });

  it('suggests, never links, when a second bank line could be the same check', () => {
    const rival = line({ id: 'line-2', txn_date: '2026-11-02' });
    const plan = planNetPay({ row: line(), checks: [check()], peers: [line(), rival] });
    expect(plan.action).toBe('suggest');
    expect(plan.candidates).toHaveLength(1);
  });

  it('ignores a rival line outside the check window, or of another amount', () => {
    const peers = [line(), line({ id: 'line-2', txn_date: '2027-02-01' }), line({ id: 'line-3', amount: '10.00' })];
    expect(planNetPay({ row: line(), checks: [check()], peers }).action).toBe('link');
  });

  it('breaks a two-check tie with the check number printed on the line', () => {
    const checks = [check({ check_number: '1041' }), check({ id: 'check-b', check_number: '1042' })];
    const peers = [line(), line({ id: 'line-2', description: 'CHECK 1041' })];
    const plan = planNetPay({ row: line({ description: 'CHECK # 001042' }), checks, peers });
    expect(plan.action).toBe('link');
    expect(plan.check.id).toBe('check-b');
  });

  it('suggests, never links, when two bank lines both print the same check number', () => {
    const checks = [check({ check_number: '1041' }), check({ id: 'check-b', check_number: '1042' })];
    const peers = [line(), line({ id: 'line-2', description: 'CHECK 1042' })];
    const plan = planNetPay({ row: line({ description: 'CHECK 1042' }), checks, peers });
    expect(plan.action).toBe('suggest');
    expect(plan.candidates.map((c) => c.id)).toEqual(['check-b']);
  });

  it('reads only the printed check number, not any other number on the line', () => {
    const numbered = check({ check_number: '1042' });
    expect(planNetPay({ row: line({ description: 'CHECK 1099 REF 1042' }), checks: [numbered] }).action).toBe('suggest');
    expect(carriesCheckNumber('CHECK 1099 REF 1042', '1042')).toBe(false);
    expect(carriesCheckNumber('CHECK 1042 REF 1099', '1042')).toBe(true);
    // a line that prints two different check numbers is not clear evidence for either
    expect(planNetPay({ row: line({ description: 'CHECK 1042 CHECK 1099' }), checks: [numbered] }).action).toBe('suggest');
  });

  it('suggests when the line prints a number that is not the check number', () => {
    const plan = planNetPay({ row: line({ description: 'CHECK 1099' }), checks: [check({ check_number: '1042' })] });
    expect(plan.action).toBe('suggest');
  });

  it('links a line that prints no number to a check whose number is not entered yet', () => {
    expect(planNetPay({ row: line({ description: 'DEBIT CARD CHECKCARD 1042' }), checks: [check()] }).action).toBe('link');
  });

  it('skips a check the owner already unlinked from this line', () => {
    expect(planNetPay({ row: line(), checks: [check()], rejected: ['check-a'] }).action).toBe('none');
  });
});

describe('tax-looking lines are never net pay', () => {
  it('leaves an EFTPS or Florida DOR debit equal to a paycheck net to tax matching', () => {
    expect(planNetPay({ row: line({ description: 'IRS USATAXPYMT 270012345' }), checks: [check()] })).toEqual({ action: 'none' });
    expect(planNetPay({ row: line({ description: 'FL DEPT OF REVENUE' }), checks: [check()] })).toEqual({ action: 'none' });
    // not even as a one-cent near miss
    expect(planNetPay({ row: line({ description: 'EFTPS PAYMENT', amount: '812.64' }), checks: [check()] })).toEqual({ action: 'none' });
  });

  it('does not let a tax line count as a rival bank line for a paycheck', () => {
    const rival = line({ id: 'tax-line', description: 'IRS USATAXPYMT', txn_date: '2026-11-02' });
    expect(planNetPay({ row: line(), checks: [check()], peers: [line(), rival] }).action).toBe('link');
  });

  it('still matches the exact tax row when a paycheck net is one cent off', () => {
    const irs = line({ id: 'tax-line', description: 'EFTPS PAYMENT', amount: '350.00', txn_date: '2026-11-13' });
    const nearCheck = check({ net_cents: 35001, pay_date: '2026-11-10' });
    expect(planNetPay({ row: irs, checks: [nearCheck] }).action).toBe('none');
    expect(planTaxPayment({ row: irs, filings: [filing()] }).action).toBe('link');
  });
});

describe('check numbers', () => {
  it('reads the numbers a statement prints', () => {
    expect(checkNumbersIn('CHECK #1042')).toEqual(['1042']);
    expect(checkNumbersIn('CHK 000987 PAID')).toEqual(['987']);
    expect(checkNumbersIn('POS DEBIT 1042')).toEqual([]);
  });

  it('matches a number only as a whole token', () => {
    expect(carriesCheckNumber('CHECK 1042', '1042')).toBe(true);
    expect(carriesCheckNumber('CHECK 11042', '1042')).toBe(false);
    expect(carriesCheckNumber('CHECK 1042', '')).toBe(false);
    expect(carriesCheckNumber('CHECK 1042', 'A-9')).toBe(false);
  });
});

describe('tax payment descriptions', () => {
  it('reads IRS and EFTPS lines as federal', () => {
    for (const d of ['IRS USATAXPYMT 270012345', 'EFTPS PAYMENT', 'IRS USA TAX PYMT', 'US TREASURY 310 TAX PYMT', 'IRS DIRECT PAY']) {
      expect(taxPaymentKind(d)).toBe('federal');
    }
  });

  it('reads Florida Department of Revenue lines as Florida, but not a sales tax payment', () => {
    expect(taxPaymentKind('FL DEPT OF REVENUE REEMPLOYMENT TAX')).toBe('florida');
    expect(taxPaymentKind('FLORIDA DEPARTMENT OF REVENUE')).toBe('florida');
    expect(taxPaymentKind('FL DEPT OF REVENUE SALES TAX')).toBe(null);
    expect(taxPaymentKind('SAMPLE SUPPLY CO')).toBe(null);
  });
});

describe('planTaxPayment', () => {
  const irs = line({ id: 'tax-line', description: 'IRS USATAXPYMT 270012345', amount: '350.00', txn_date: '2026-11-13' });

  it('links one IRS debit to the one deposit row of the same amount', () => {
    const plan = planTaxPayment({ row: irs, filings: [filing()], peers: [irs] });
    expect(plan.action).toBe('link');
    expect(plan.filing.id).toBe('fil-1');
    expect(plan.tax).toBe('federal');
  });

  it('matches the amount the owner recorded paying over the amount due', () => {
    const paid = filing({ amount_paid: '351.00', status: 'paid' });
    expect(filingCents(paid)).toBe(35100);
    expect(planTaxPayment({ row: irs, filings: [paid] }).action).toBe('none');
    expect(planTaxPayment({ row: { ...irs, amount: '351.00' }, filings: [paid] }).action).toBe('link');
  });

  it('matches a balance row too', () => {
    const balance = filing({ id: 'fil-2', source_key: 'payroll:941_deposit:2026-10:balance:1', amount_due: '40.00' });
    expect(planTaxPayment({ row: { ...irs, amount: '40.00' }, filings: [filing(), balance] }).filing.id).toBe('fil-2');
  });

  it('keeps the deposit window from the month start to 14 days after the due date', () => {
    expect(taxWindow(filing())).toEqual({ tax: 'federal', from: '2026-10-01', to: '2026-11-30' });
    const at = (txn_date) => planTaxPayment({ row: { ...irs, txn_date }, filings: [filing()] }).action;
    expect(at('2026-09-30')).toBe('none');
    expect(at('2026-10-01')).toBe('link');
    expect(at('2026-11-30')).toBe('link');
    expect(at('2026-12-01')).toBe('none');
  });

  it('matches an RT-6 row only to a Florida Department of Revenue line', () => {
    const rt6 = filing({ id: 'fil-3', source_key: 'payroll:rt6:2026-Q3', due_date: '2026-10-30', amount_due: '12.34' });
    expect(taxWindow(rt6)).toEqual({ tax: 'florida', from: '2026-07-01', to: '2026-11-13' });
    const fl = line({ id: 'fl-line', description: 'FL DEPT OF REVENUE', amount: '12.34', txn_date: '2026-10-28' });
    expect(planTaxPayment({ row: fl, filings: [rt6] }).action).toBe('link');
    expect(planTaxPayment({ row: { ...fl, description: 'IRS USATAXPYMT' }, filings: [rt6] }).action).toBe('none');
  });

  it('suggests when two rows share the amount or two IRS lines share it', () => {
    const second = filing({ id: 'fil-4', source_key: 'payroll:941_deposit:2026-09', due_date: '2026-10-15' });
    expect(planTaxPayment({ row: { ...irs, txn_date: '2026-10-10' }, filings: [filing(), second] }).action).toBe('suggest');
    const twin = { ...irs, id: 'tax-line-2', txn_date: '2026-11-14' };
    expect(planTaxPayment({ row: irs, filings: [filing()], peers: [irs, twin] }).action).toBe('suggest');
  });

  it('never matches review rows, FUTA alerts, rows without an amount, or other filings', () => {
    const rows = [
      filing({ source_key: 'payroll:941_deposit:2026-10:review:1' }),
      filing({ source_key: 'payroll:futa_over_500:2026' }),
      filing({ source_key: 'payroll:941:2026-Q3' }),
      filing({ source_key: 'dr15:2026-10' }),
      filing({ amount_due: null }),
    ];
    for (const f of rows) expect(planTaxPayment({ row: irs, filings: [f] }).action).toBe('none');
  });

  it('suggests a one-cent-off IRS payment', () => {
    const plan = planTaxPayment({ row: { ...irs, amount: '350.01' }, filings: [filing()] });
    expect(plan.action).toBe('suggest');
    expect(plan.candidates[0]).toMatchObject({ kind: 'tax', nearMiss: true });
  });
});

describe('owner picks', () => {
  it('accept one cent of slack inside the window, nothing else', () => {
    expect(isPlausibleCheckLink(line({ amount: '812.64' }), check())).toBe(true);
    expect(isPlausibleCheckLink(line({ amount: '812.66' }), check())).toBe(false);
    expect(isPlausibleCheckLink(line({ txn_date: '2027-03-01' }), check())).toBe(false);
    expect(isPlausibleCheckLink(line({ direction: 'credit' }), check())).toBe(false);
    const irs = line({ description: 'EFTPS', amount: '350.00', txn_date: '2026-11-13' });
    expect(isPlausibleTaxLink(irs, filing())).toBe(true);
    expect(isPlausibleTaxLink({ ...irs, description: 'FL DEPT OF REVENUE' }, filing())).toBe(false);
  });
});
