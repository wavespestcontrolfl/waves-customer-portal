/**
 * Cash forecast loader: the JS around the reads (opening pool, lanes and values, the trailing window,
 * missing-data facts) against a fake database keyed on each query's text. Synthetic numbers only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/plaid-sync', () => ({ readCashBalances: jest.fn() }));
jest.mock('../services/stripe-banking', () => ({ getBalance: jest.fn() }));
jest.mock('../services/cash-forecast/inputs', () => ({
  getSettings: jest.fn(async () => ({ floor_cents: null, last_year_receipts: {}, updated_at: null })),
  listItems: jest.fn(async () => []),
}));
jest.mock('../services/monthly-dues-eligibility', () => ({
  DUES_COHORT_COLUMNS: ['id', 'monthly_rate', 'billing_day', 'billing_mode'],
  applyDuesCohort: jest.fn((q) => q),
  autopayGuard: jest.fn(() => null),
  laneGuard: jest.fn((c) => (c.billing_mode === 'monthly_membership' ? null : { event: 'skipped_billing_mode' })),
  monthlyDuesVerdict: jest.fn(async () => ({ eligible: true })),
}));

const { loadForecastInput, _private } = require('../services/cash-forecast/load');

// 21:30 ET on Thursday Nov 5 is already Nov 6 in UTC: every bound day must still be Nov 5.
const NOW = new Date('2026-11-06T02:30:00Z');

function fakeDb({ raw = [], tables = {} } = {}) {
  const calls = [];
  const database = (name) => {
    const rows = tables[name] || [];
    const q = {};
    ['where', 'whereIn', 'whereNull', 'select', 'orderBy'].forEach((m) => { q[m] = () => q; });
    q.then = (res, rej) => Promise.resolve(rows).then(res, rej);
    return q;
  };
  database.raw = async (sql, bindings = []) => {
    calls.push({ sql, bindings });
    for (const [re, rows] of raw) if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(bindings) : rows };
    return { rows: [] };
  };
  database.calls = calls;
  return database;
}

const visit = (over) => ({
  id: 'v', status: 'pending', scheduled_day: '2026-11-10', completed_day: null, prepaid_amount: 0, annual_prepay_term_id: null,
  effective_price: 100, payer_billed: false, is_callback: false, free_type: false, unpriced_consultation: false,
  billing_mode: 'per_visit', waveguard_tier: null, monthly_rate: 0, ...over,
});

const cashOk = async () => ({
  accounts: [
    { account_label: 'chk-a', currency: 'USD', available: 900, current: 1000 },
    { account_label: 'chk-b', currency: 'USD', available: null, current: 300 },
    { account_label: 'eur', currency: 'EUR', available: 50, current: 50 },
  ],
  // a card in credit (-40) owes nothing and never offsets another card
  cards: [{ account_label: 'card-f', currency: 'USD', current: 120 }, { account_label: 'card-g', currency: 'USD', current: -40 }],
  unavailable: [],
});

describe('visit value (cash lanes, self-pay, less prepaid)', () => {
  test('per-visit, per-application and one-time count; the dues lane, annual prepay, payer, callback and free types do not', () => {
    const { visitValue } = _private;
    expect(visitValue(visit({}))).toBe(100);
    expect(visitValue(visit({ billing_mode: 'per_application' }))).toBe(100);
    expect(visitValue(visit({ billing_mode: 'one_time', prepaid_amount: 30 }))).toBe(70);
    // a member's recurring visit, dues on autopay: the dues pay for it
    const member = { billing_mode: 'monthly_membership', waveguard_tier: 'Bronze', monthly_rate: 50, autopay_active: true, is_recurring: true };
    expect(visitValue(visit(member))).toBe(0);
    expect(visitValue(visit({ ...member, billing_mode: null }))).toBe(0); // inferred member
    // the dues run cannot collect without autopay, and a priced one-time visit is billed on its own
    expect(visitValue(visit({ ...member, autopay_active: false }))).toBe(100);
    expect(visitValue(visit({ ...member, is_recurring: false, estimated_price: 200, effective_price: 200 }))).toBe(200);
    expect(visitValue(visit({ annual_prepay_term_id: 't1' }))).toBe(0);
    expect(visitValue(visit({ payer_billed: true }))).toBe(0);
    expect(visitValue(visit({ is_callback: true }))).toBe(0);
    expect(visitValue(visit({ free_type: true }))).toBe(0);
    expect(visitValue(visit({ unpriced_consultation: true }))).toBe(0);
    expect(visitValue(visit({ prepaid_amount: 150 }))).toBe(0);
  });

  test('GATE_STAMPED_ZERO_FREE decides whether a stamped $0 falls to the per-application fee', () => {
    const saved = process.env.GATE_STAMPED_ZERO_FREE;
    try {
      process.env.GATE_STAMPED_ZERO_FREE = 'true';
      expect(_private.effectivePriceSql()).not.toMatch(/NULLIF/);
      process.env.GATE_STAMPED_ZERO_FREE = 'false';
      expect(_private.effectivePriceSql()).toMatch(/NULLIF\(ss\.estimated_price, 0\)/);
    } finally {
      if (saved === undefined) delete process.env.GATE_STAMPED_ZERO_FREE; else process.env.GATE_STAMPED_ZERO_FREE = saved;
    }
  });
});

describe('loadForecastInput', () => {
  test('binds ET days from the app clock, never the UTC date', async () => {
    const database = fakeDb();
    const input = await loadForecastInput({ database, now: NOW, readCashBalances: cashOk, readStripeBalance: async () => ({}) });
    expect(input.today).toBe('2026-11-05');
    const visits = database.calls.find((c) => /FROM scheduled_services ss/.test(c.sql));
    expect(visits.bindings[0]).toBe('2026-11-05'); // the autopay check's ET day
    expect(visits.bindings.slice(5, 7)).toEqual(['2026-06-08', '2027-01-31']); // 150 days back .. Sunday of week 12
    const bank = database.calls.find((c) => /FROM bank_transactions bt/.test(c.sql));
    expect(bank.bindings).toEqual([['chk-a', 'chk-b', 'card-f', 'card-g'], '2026-08-28', '2026-11-11']); // trailing Sep 7 - Nov 1 +- 10 days; USD only
    for (const c of database.calls) expect(c.sql).not.toMatch(/current_date|now\(\)/i);
    // open invoices include 'overdue'; a pay run's net goes out on the pay date and the 941 return is never a payment
    expect(database.calls.find((c) => /i\.credit_applied, i\.amount_paid/.test(c.sql)).bindings).toEqual([['sent', 'viewed', 'overdue', 'processing']]);
    const pay = database.calls.find((c) => /FROM payroll_checks pc/.test(c.sql));
    expect(pay.sql).toMatch(/pc\.net_cents/);
    expect(pay.bindings).toEqual(['2026-10-01', '2027-01-31']); // 35 days back, for the weekly projection
    expect(database.calls.find((c) => /FROM tax_filing_calendar/.test(c.sql)).sql).toMatch(/filing_type <> 'payroll_941'/);
  });

  test('opening pool: available else current, USD only; card owed; partial when an account is left out', async () => {
    const input = await loadForecastInput({ database: fakeDb(), now: NOW, readCashBalances: cashOk, readStripeBalance: async () => ({ total_available: 10, total_pending: 20 }) });
    // the EUR account is not in the dollar total, so the opening is marked partial
    expect(input.opening).toEqual({ bankUsd: 1200, cardOwedUsd: 120, partial: true });
    expect(input.stripe).toMatchObject({ availableUsd: 10, pendingUsd: 20 });
    expect(input.poolAccounts).toEqual(['chk-a', 'chk-b']);
    expect(input.feedCards).toEqual(['card-f', 'card-g']);

    const dollars = async () => ({ accounts: [{ account_label: 'chk-a', currency: 'USD', available: 900, current: 1000 }], cards: [], unavailable: [] });
    const whole = await loadForecastInput({ database: fakeDb(), now: NOW, readCashBalances: dollars, readStripeBalance: async () => ({}) });
    expect(whole.opening).toEqual({ bankUsd: 900, cardOwedUsd: 0, partial: false });

    const partial = await loadForecastInput({
      database: fakeDb(), now: NOW, readStripeBalance: async () => ({}),
      readCashBalances: async () => ({ accounts: [{ account_label: 'chk-a', currency: 'USD', available: null, current: null }], cards: [], unavailable: [{ institution_name: 'Bank', reason: 'login_required' }] }),
    });
    expect(partial.opening).toEqual({ bankUsd: null, cardOwedUsd: 0, partial: true });
    expect(partial.missing).toContainEqual({ kind: 'account_unavailable', institution: 'Bank', reason: 'login_required', mask: null });
  });

  test('a failed cash or Stripe read degrades to a missing-data line, not a crash', async () => {
    const input = await loadForecastInput({
      database: fakeDb(), now: NOW,
      readCashBalances: async () => { throw new Error('plaid down'); },
      readStripeBalance: async () => { throw new Error('stripe down'); },
    });
    expect(input.opening).toEqual({ bankUsd: null, cardOwedUsd: 0, partial: true });
    expect(input.missing.map((m) => m.kind)).toEqual(expect.arrayContaining(['balance_unavailable', 'stripe_balance_unavailable']));
  });

  test('visits: completed cash work is the cohort and the trailing baseline; open visits are booked; facts listed', async () => {
    const database = fakeDb({
      raw: [
        [/FROM scheduled_services ss/, [
          visit({ id: 'c1', status: 'completed', scheduled_day: '2026-10-20', completed_day: '2026-10-20' }),
          visit({ id: 'c2', status: 'completed', scheduled_day: '2026-09-01', completed_day: '2026-09-01', effective_price: 50 }),
          visit({ id: 'c3', status: 'completed', scheduled_day: '2026-10-21', completed_day: '2026-10-21', billing_mode: 'monthly_membership', waveguard_tier: 'Bronze', monthly_rate: 50, autopay_active: true, is_recurring: true }),
          visit({ id: 'b1', scheduled_day: '2026-11-05' }),
          visit({ id: 'b3', scheduled_day: '2026-11-06', has_invoice: true }),
          visit({ id: 'b2', scheduled_day: '2026-11-12', payer_billed: true }),
          visit({ id: 'old', scheduled_day: '2026-11-04' }),
        ]],
        [/AS visit_id/, [{ visit_id: 'c1', paid_day: '2026-10-22', paid_amount: 100 }]],
        // open: the canonical amount due (total - credit applied - amount paid)
        [/i\.credit_applied, i\.amount_paid/, [{ sent_day: '2026-10-26', status: 'sent', total: 60, credit_applied: 10, amount_paid: 10 }, { sent_day: '2026-11-05', status: 'processing', total: 25 }]],
        // sent: a credit is not new money, so the invoice's value is what was left to pay
        [/i\.credit_applied, i\.status/, [{ sent_day: '2026-10-20', total: 100, credit_applied: 20, status: 'paid', paid_day: '2026-10-25', paid_amount: 80 }]],
        [/i\.status = 'draft'/, [{ n: 2, total: 300 }]],
        [/FROM tax_filing_calendar/, [{ due_day: '2026-11-20', amount_due: null }, { due_day: '2026-12-15', amount_due: 500, amount_paid: 100 }]],
        // t1 has a check in the window; t2 was last paid Oct 30 (inside the 35-day look-back)
        [/FROM payroll_checks pc/, [
          { technician_id: 't2', pay_day: '2026-10-30', net_cents: 60000, full_cents: 90000 },
          { technician_id: 't1', pay_day: '2026-11-13', net_cents: 81234, full_cents: 100000 },
        ]],
        [/WITH last AS/, [{ account_label: 'old-card', last_day: '2026-10-27', debits_30d: 900 }]],
      ],
    });
    const input = await loadForecastInput({ database, now: NOW, readCashBalances: cashOk, readStripeBalance: async () => ({}) });
    expect(input.visitCohort).toEqual([
      { value: 100, ageDays: 16, paid: [{ lagDays: 2, amount: 100 }] },
      { value: 50, ageDays: 65, paid: [] },
    ]);
    // trailing Sep 7 - Nov 1: c1 and c3 (the member visit counts as a visit, not as cash work); c2 is before it
    expect(input.trailing).toMatchObject({ visits: 2, workValueUsd: 100 });
    // b3 is already invoiced: its cash comes once, as its invoice, but it is still booked work
    expect(input.booked).toEqual([
      { day: '2026-11-05', value: 100, work: 100 }, { day: '2026-11-06', value: 0, work: 100 }, { day: '2026-11-12', value: 0, work: 0 },
    ]);
    expect(input.openInvoices).toEqual([{ amountUsd: 40, ageDays: 10, processing: false }, { amountUsd: 25, ageDays: 0, processing: true }]);
    expect(input.invoiceCohort).toEqual([{ value: 80, ageDays: 16, paid: [{ lagDays: 5, amount: 80 }] }]);
    expect(input.taxRows).toEqual([{ dueDay: '2026-12-15', amountUsd: 400 }]);
    // the check in the window pays its net; each employee then repeats weekly at full cost (last 4 checks)
    expect(input.payroll[0]).toEqual({ payDay: '2026-11-13', cashCostUsd: 812.34 });
    const projected = input.payroll.slice(1);
    expect(projected.filter((p) => p.cashCostUsd === 900).map((p) => p.payDay).slice(0, 2)).toEqual(['2026-11-06', '2026-11-13']);
    expect(projected.filter((p) => p.cashCostUsd === 900)).toHaveLength(13); // Nov 6 .. Jan 29
    expect(projected.filter((p) => p.cashCostUsd === 1000).map((p) => p.payDay)[0]).toBe('2026-11-20');
    expect(projected.filter((p) => p.cashCostUsd === 1000)).toHaveLength(11); // Nov 20 .. Jan 29
    expect(input.missing).toEqual(expect.arrayContaining([
      { kind: 'payer_billed_visits', count: 1 },
      { kind: 'completed_visits_not_billed', count: 1, usd: 50 },
      { kind: 'draft_invoices', count: 2, usd: 300 },
      { kind: 'tax_rows_without_amount', count: 1 },
      { kind: 'card_not_in_feed', account: 'old-card', last_day: '2026-10-27', debits_30d_usd: 900 },
    ]));
  });

  test('dues: the dues run cohort and verdict; billing day NULL = the 1st; a day the month lacks is skipped', async () => {
    const database = fakeDb({ tables: { customers: [
      { id: 'm1', billing_mode: 'monthly_membership', monthly_rate: 80, billing_day: null },
      { id: 'm2', billing_mode: 'monthly_membership', monthly_rate: 60, billing_day: 31 },
      { id: 'p1', billing_mode: 'per_visit', monthly_rate: 40, billing_day: 1 },
    ] } });
    const input = await loadForecastInput({ database, now: NOW, readCashBalances: cashOk, readStripeBalance: async () => ({}) });
    expect(input.dues).toEqual([
      { day: '2026-12-01', amountUsd: 80 }, { day: '2027-01-01', amountUsd: 80 },
      { day: '2026-12-31', amountUsd: 60 }, { day: '2027-01-31', amountUsd: 60 },
    ]);
  });
});
