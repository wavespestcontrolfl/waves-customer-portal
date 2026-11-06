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
  listMarks: jest.fn(async () => ({ 'ACME LOAN': 'household' })),
}));
jest.mock('../services/open-balance', () => ({
  applyOpenSelfPayPredicates: jest.fn((q) => q),
  rowIsSelfPayDue: jest.fn(async (customerId, row) => row.invoice_number !== 'PAYER-OWNED'),
}));
jest.mock('../services/monthly-dues-eligibility', () => ({
  DUES_COHORT_COLUMNS: ['id', 'monthly_rate', 'billing_day', 'billing_mode'],
  applyDuesCohort: jest.fn((q) => q),
  autopayGuard: jest.fn(() => null),
  laneGuard: jest.fn((c) => (c.billing_mode === 'monthly_membership' ? null : { event: 'skipped_billing_mode' })),
  monthlyDuesVerdict: jest.fn(async () => ({ eligible: true })),
}));
// The two answers the completion prediction takes from the database.
jest.mock('../services/billing-lane', () => ({
  ...jest.requireActual('../services/billing-lane'),
  monthlyDuesCollected: jest.fn(async () => false),
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  ANNUAL_PREPAY_PREPAID_METHOD: 'annual_prepay_invoice',
  deferredPrepayHoldCustomerIds: jest.fn(async () => new Set()),
  annualCoverageVerdictForPrediction: jest.fn(async () => null),
}));

const { applyOpenSelfPayPredicates } = require('../services/open-balance');
const { monthlyDuesCollected } = require('../services/billing-lane');
const AnnualPrepay = require('../services/annual-prepay-renewals');
const { loadForecastInput, _private } = require('../services/cash-forecast/load');

// 21:30 ET on Thursday Nov 5 is already Nov 6 in UTC: every bound day must still be Nov 5.
const NOW = new Date('2026-11-06T02:30:00Z');

function fakeDb({ raw = [], tables = {} } = {}) {
  const calls = [];
  const database = (name) => {
    const rows = tables[name] || [];
    const q = {};
    ['where', 'whereIn', 'whereNull', 'whereRaw', 'select', 'orderBy'].forEach((m) => { q[m] = () => q; });
    q.then = (res, rej) => Promise.resolve(rows).then(res, rej);
    q.first = () => Promise.resolve(rows[0]);
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
  id: 'v', customer_id: 'k-v', status: 'pending', scheduled_day: '2026-11-10', completed_day: null, prepaid_amount: 0,
  prepaid_method: null, estimated_price: 100, primary_line_price: null, service_type: 'Quarterly Pest Control Service',
  payer_billed: false, is_callback: false, is_recurring: false, autopay_active: false, billing_mode: 'per_visit',
  waveguard_tier: null, monthly_rate: 0, per_application_fee: null, ...over,
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

describe('visit value: what completing it bills (billing-lane predictCompletionBilling)', () => {
  const { predictedCash, valueVisits } = _private;
  const member = { billing_mode: 'monthly_membership', waveguard_tier: 'Bronze', monthly_rate: 80, autopay_active: true, is_recurring: true };

  beforeEach(() => {
    monthlyDuesCollected.mockReset().mockResolvedValue(false);
    AnnualPrepay.deferredPrepayHoldCustomerIds.mockReset().mockResolvedValue(new Set());
    AnnualPrepay.annualCoverageVerdictForPrediction.mockReset().mockResolvedValue(null);
  });

  test('a cash lane bills its price less a prepayment; payer-billed, callback, free-type and annual-stamped visits bring nothing', () => {
    expect(predictedCash(visit({}))).toBe(100);
    expect(predictedCash(visit({ billing_mode: 'one_time', prepaid_amount: 30 }))).toBe(70);
    expect(predictedCash(visit({ prepaid_amount: 150 }))).toBe(0);
    expect(predictedCash(visit({ estimated_price: null }))).toBe(0); // an unpriced per-visit visit bills nothing
    expect(predictedCash(visit({ billing_mode: 'annual_prepay', prepaid_method: 'annual_prepay_invoice' }))).toBe(0);
    expect(predictedCash(visit({}), { annualCoverage: true })).toBe(0); // held by a deferred prepay year
    expect(predictedCash(visit({ payer_billed: true }))).toBe(0);
    expect(predictedCash(visit({ is_callback: true }))).toBe(0);
    expect(predictedCash(visit({ service_type: 'Re-Service' }))).toBe(0);
  });

  test('per application: the fee when the row has no price; a stamped $0 follows GATE_STAMPED_ZERO_FREE', () => {
    const perApp = { billing_mode: 'per_application', per_application_fee: 50 };
    expect(predictedCash(visit({ ...perApp, estimated_price: null }))).toBe(50);
    const saved = process.env.GATE_STAMPED_ZERO_FREE;
    try {
      process.env.GATE_STAMPED_ZERO_FREE = 'true';
      expect(predictedCash(visit({ ...perApp, estimated_price: 0 }))).toBe(0);
      process.env.GATE_STAMPED_ZERO_FREE = 'false';
      expect(predictedCash(visit({ ...perApp, estimated_price: 0 }))).toBe(50);
    } finally {
      if (saved === undefined) delete process.env.GATE_STAMPED_ZERO_FREE; else process.env.GATE_STAMPED_ZERO_FREE = saved;
    }
  });

  test('members: the dues cover a recurring visit on Auto Pay or in a month already paid for; else it bills the monthly rate', () => {
    expect(predictedCash(visit({ ...member, estimated_price: null }))).toBe(0);
    expect(predictedCash(visit({ ...member, billing_mode: null, estimated_price: null }))).toBe(0); // inferred member
    expect(predictedCash(visit({ ...member, autopay_active: false, estimated_price: null }))).toBe(80);
    expect(predictedCash(visit({ ...member, autopay_active: false, estimated_price: null }), { duesCollected: true })).toBe(0);
    expect(predictedCash(visit({ ...member, is_recurring: false, estimated_price: 200 }))).toBe(200); // a priced one-off
  });

  test('a member without Auto Pay is billed once a month: the database answers for a month, else the first visit bills', async () => {
    // November's dues are already paid; December has no record yet
    monthlyDuesCollected.mockImplementation(async (db, customerId, when) => when.toISOString().startsWith('2026-11'));
    const noAutopay = { ...member, customer_id: 'm1', autopay_active: false, estimated_price: null };
    const rows = [
      visit({ ...noAutopay, id: 'd2', scheduled_day: '2026-12-17' }),
      visit({ ...noAutopay, id: 'n1', scheduled_day: '2026-11-12' }),
      visit({ ...noAutopay, id: 'd1', scheduled_day: '2026-12-03' }),
      visit({ id: 'p1', scheduled_day: '2026-12-10' }), // per visit: its price, and no dues read
    ];
    const values = await valueVisits(fakeDb(), rows);
    expect(Object.fromEntries(values)).toEqual({ n1: 0, d1: 80, d2: 0, p1: 100 });
    // each read leaves out the visit's own invoice; d2 rides the invoice d1 will bring
    expect(monthlyDuesCollected.mock.calls.map((c) => [c[1], c[3]])).toEqual([
      ['m1', { excludeScheduledServiceId: 'n1' }], ['m1', { excludeScheduledServiceId: 'd1' }],
    ]);
  });

  test('annual prepay: a stamped visit and a deferred-year customer\'s visit take the year\'s verdict; others are never read', async () => {
    AnnualPrepay.deferredPrepayHoldCustomerIds.mockResolvedValue(new Set(['k-held']));
    // h1: held by a waiting year; s1: a live stamp; s2: a stale stamp (its year was refunded)
    const verdict = { h1: true, s1: true, s2: false };
    AnnualPrepay.annualCoverageVerdictForPrediction.mockImplementation(async (full) => verdict[full.id]);
    const stamp = { billing_mode: 'per_application', per_application_fee: 90, estimated_price: null, prepaid_method: 'annual_prepay_invoice', prepaid_amount: 90 };
    const database = fakeDb({ tables: { scheduled_services: [{ id: 'h1', customer_id: 'k-held' }, { id: 's1' }, { id: 's2' }] } });
    const values = await valueVisits(database, [
      visit({ id: 'h1', customer_id: 'k-held' }),
      visit({ id: 's1', customer_id: 'k-s', ...stamp }),
      visit({ id: 's2', customer_id: 'k-s', ...stamp }),
      visit({ id: 'x1', customer_id: 'k-other' }),
    ]);
    // the stale stamp is not a prepayment: completion bills the fee
    expect(Object.fromEntries(values)).toEqual({ h1: 0, s1: 0, s2: 90, x1: 100 });
    expect(AnnualPrepay.annualCoverageVerdictForPrediction.mock.calls.map((c) => c[0].id).sort()).toEqual(['h1', 's1', 's2']);
  });

  test('an unreadable annual check keeps no verdict (one log line); a failed batch read keeps none and the values still come', async () => {
    const logger = require('../services/logger');
    AnnualPrepay.annualCoverageVerdictForPrediction.mockRejectedValue(new Error('stamped visit carries no annual_prepay_term_id'));
    const stamp = { billing_mode: 'annual_prepay', estimated_price: 120, prepaid_method: 'annual_prepay_invoice' };
    const database = fakeDb({ tables: { scheduled_services: [{ id: 'u1' }, { id: 'u2' }] } });
    // no verdict: in the annual lane the prediction falls back to the stamp
    expect(Object.fromEntries(await valueVisits(database, [visit({ id: 'u1', ...stamp }), visit({ id: 'u2', ...stamp })]))).toEqual({ u1: 0, u2: 0 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unreadable for 2 visit(s)'));
    AnnualPrepay.deferredPrepayHoldCustomerIds.mockRejectedValue(new Error('down'));
    expect(Object.fromEntries(await valueVisits(database, [visit({ id: 'u1', ...stamp }), visit({ id: 'p1' })]))).toEqual({ u1: 0, p1: 100 });
  });

  test('a month the dues run is projected to charge covers that member\'s visits: never counted twice', async () => {
    const noAutopay = { ...member, customer_id: 'm1', autopay_active: false, estimated_price: null };
    const rows = [visit({ ...noAutopay, id: 'j1', scheduled_day: '2027-01-08' }), visit({ ...noAutopay, id: 'f1', scheduled_day: '2027-02-02' })];
    // Auto Pay resumes before January's run, so January's dues come from the run, not from j1
    const values = await valueVisits(fakeDb(), rows, { duesMonths: new Set(['m1|2027-01']) });
    expect(Object.fromEntries(values)).toEqual({ j1: 0, f1: 80 });
  });

  test('a failed read never counts money it cannot place: unread dues count the month as paid', async () => {
    monthlyDuesCollected.mockRejectedValue(new Error('read failed'));
    const values = await valueVisits(fakeDb(), [visit({ ...member, id: 'f1', customer_id: 'm2', autopay_active: false, estimated_price: null })]);
    expect(values.get('f1')).toBe(0);
  });
});

describe('shared definitions', () => {
  test('open-balance exports the open-self-pay predicates the loader applies', () => {
    expect(typeof jest.requireActual('../services/open-balance').applyOpenSelfPayPredicates).toBe('function');
  });
});

describe('payment events', () => {
  test('part payments on their own dates, the rest on the paid-in-full day; nothing twice', () => {
    const parts = new Map([['i1', [{ paid_day: '2026-10-02', amount: 30 }]]]);
    expect(_private.payEvents({ id: 'i1', paid_day: '2026-10-09', settled: 100 }, parts)).toEqual([
      { day: '2026-10-02', amount: 30 }, { day: '2026-10-09', amount: 70 },
    ]);
    // still open: only the part payment counts
    expect(_private.payEvents({ id: 'i1', paid_day: null, settled: 0 }, parts)).toEqual([{ day: '2026-10-02', amount: 30 }]);
    expect(_private.payEvents({ id: 'i2', paid_day: '2026-10-09', settled: 100 }, parts)).toEqual([{ day: '2026-10-09', amount: 100 }]);
  });
});

describe('loadForecastInput', () => {
  beforeEach(() => monthlyDuesCollected.mockReset().mockResolvedValue(false));

  test('binds ET days from the app clock, never the UTC date', async () => {
    const database = fakeDb();
    const input = await loadForecastInput({ database, now: NOW, readCashBalances: cashOk, readStripeBalance: async () => ({}) });
    expect(input.today).toBe('2026-11-05');
    const visits = database.calls.find((c) => /FROM scheduled_services ss/.test(c.sql));
    expect(visits.bindings[0]).toBe('2026-11-05'); // the autopay check's ET day
    expect(visits.bindings.slice(3, 5)).toEqual(['2026-06-08', '2027-01-31']); // 150 days back .. Sunday of week 12
    const bank = database.calls.find((c) => /FROM bank_transactions bt/.test(c.sql));
    // from 120 days back (the repeating-bill finder; earlier than trailing Sep 7 less 10 days) to Nov 1 + 10 days; USD only
    expect(bank.bindings).toEqual([['chk-a', 'chk-b', 'card-f', 'card-g'], '2026-07-08', '2026-11-11']);
    expect(input.marks).toEqual({ 'ACME LOAN': 'household' }); // the owner's labels ride along to the engine
    for (const c of database.calls) expect(c.sql).not.toMatch(/current_date|now\(\)/i);
    // open invoices are the shared open-self-pay set; a pay run's net goes out on the pay date and the 941 return is never a payment
    expect(applyOpenSelfPayPredicates).toHaveBeenCalled();
    const pay = database.calls.find((c) => /FROM payroll_checks pc/.test(c.sql));
    expect(pay.sql).toMatch(/pc\.net_cents/);
    expect(pay.sql).toMatch(/pp\.state IN \('sent', 'paper'\)\)\s+OR EXISTS \(SELECT 1 FROM bank_transactions bt WHERE bt\.matched_payroll_check_id = pc\.id\)\) AS paid_out/);
    expect(pay.bindings).toEqual(['2026-10-01', '2027-01-31']); // 35 days back, for the weekly projection
    // a check past its pay date is still owed only on the portal's own record: a payment row, none sent or
    // paid by paper, and no bank line matched
    const owed = database.calls.find((c) => /FROM payroll_checks pc[\s\S]*payroll_payments/.test(c.sql));
    expect(owed.bindings).toEqual(['2026-11-05']);
    expect(owed.sql).toMatch(/EXISTS \(SELECT 1 FROM payroll_payments pp WHERE pp\.check_id = pc\.id\)/);
    expect(owed.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM payroll_payments pp WHERE pp\.check_id = pc\.id AND pp\.state IN \('sent', 'paper'\)\)/);
    const tax = database.calls.find((c) => /FROM tax_filing_calendar/.test(c.sql));
    expect(tax.sql).toMatch(/filing_type <> 'payroll_941'/);
    expect(tax.bindings).toEqual(['2025-10-01', '2027-01-31']); // unpaid rows 400 days back stay owed
    // a payer bills the visit only while it is active (payer.js resolveForInvoice); else it is self-pay
    expect(visits.sql).toMatch(/FROM payers p\s+WHERE p\.id = COALESCE\(ss\.payer_id, CASE WHEN COALESCE\(ss\.self_pay_override, false\) THEN NULL ELSE c\.payer_id END\)\s+AND p\.active IS DISTINCT FROM false/);
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
      tables: { invoices: [
        { sent_day: '2026-10-26', status: 'sent', total: 60, credit_applied: 10, amount_paid: 10, invoice_number: 'A-1', customer_id: 'k1' },
        // the live payer re-check says a payer owns this one: left out
        { sent_day: '2026-10-27', status: 'sent', total: 90, invoice_number: 'PAYER-OWNED', customer_id: 'k2' },
      ] },
      raw: [
        [/FROM scheduled_services ss/, [
          visit({ id: 'c1', status: 'completed', scheduled_day: '2026-10-20', completed_day: '2026-10-20' }),
          visit({ id: 'c2', status: 'completed', scheduled_day: '2026-09-01', completed_day: '2026-09-01', estimated_price: 50 }),
          // covered by a combined invoice on another visit: billed, so not listed (its cash sits on the anchor)
          visit({ id: 'c4', status: 'completed', scheduled_day: '2026-10-22', completed_day: '2026-10-22', estimated_price: 30, has_invoice: true }),
          visit({ id: 'c3', status: 'completed', scheduled_day: '2026-10-21', completed_day: '2026-10-21', billing_mode: 'monthly_membership', waveguard_tier: 'Bronze', monthly_rate: 50, autopay_active: true, is_recurring: true }),
          visit({ id: 'b1', scheduled_day: '2026-11-05' }),
          visit({ id: 'b3', scheduled_day: '2026-11-06', has_invoice: true }),
          visit({ id: 'b2', scheduled_day: '2026-11-12', payer_billed: true }),
          visit({ id: 'old', scheduled_day: '2026-11-04' }),
        ]],
        [/AS visit_id/, [{ id: 'vi1', visit_id: 'c1', paid_day: '2026-10-22', settled: 100 }]],
        // sent: a credit is not new money, so the invoice's value is what was left to pay; a part payment came first
        [/i\.credit_applied, i\.status/, [{ id: 's1', sent_day: '2026-10-20', total: 100, credit_applied: 20, status: 'paid', paid_day: '2026-10-25', settled: 80 }]],
        [/partial_payment/, [{ invoice_id: 's1', paid_day: '2026-10-21', amount: 30 }]],
        [/i\.status = 'draft'/, [{ n: 2, total: 300 }]],
        [/FROM tax_filing_calendar/, [
          { due_day: '2026-11-20', amount_due: null },
          { due_day: '2026-12-15', amount_due: 500, amount_paid: 100 },
          { due_day: '2026-10-20', amount_due: 250, amount_paid: 0 }, // overdue and unpaid: still owed, counted today
        ]],
        // an Oct 23 check whose bank transfer failed is still owed: it counts today
        [/FROM payroll_checks pc[\s\S]*payroll_payments/, [{ pay_day: '2026-10-23', net_cents: 45000 }]],
        // t1 has a check in the window; t2 was last paid Oct 30 (inside the 35-day look-back)
        [/FROM payroll_checks pc/, [
          { technician_id: 't2', pay_day: '2026-10-30', net_cents: 60000, full_cents: 90000 },
          { technician_id: 't1', pay_day: '2026-11-13', net_cents: 81234, full_cents: 100000 },
          // sent early, before its pay date: already in the opening balance, but still a check for the projection
          { technician_id: 't3', pay_day: '2026-11-06', net_cents: 50000, full_cents: 70000, paid_out: true },
        ]],
        [/WITH last AS/, [{ account_label: 'old-card', last_day: '2026-10-27', debits_30d: 900 }]],
      ],
    });
    const input = await loadForecastInput({ database, now: NOW, readCashBalances: cashOk, readStripeBalance: async () => ({}) });
    expect(input.visitCohort).toEqual([
      { value: 100, ageDays: 16, paid: [{ lagDays: 2, amount: 100 }] },
      { value: 50, ageDays: 65, paid: [] },
      { value: 30, ageDays: 14, paid: [] },
    ]);
    // trailing Sep 7 - Nov 1: c1 and c3 (the member visit counts as a visit, not as cash work); c2 is before it
    expect(input.trailing).toMatchObject({ visits: 3, workValueUsd: 130 });
    // b3 is already invoiced: its cash comes once, as its invoice, but it is still booked work
    expect(input.booked).toEqual([
      { day: '2026-11-05', value: 100, work: 100 }, { day: '2026-11-06', value: 0, work: 100 }, { day: '2026-11-12', value: 0, work: 0 },
    ]);
    // open: the canonical amount due (total - credit applied - amount paid)
    expect(input.openInvoices).toEqual([{ amountUsd: 40, ageDays: 10 }]);
    expect(input.invoiceCohort).toEqual([{ value: 80, ageDays: 16, paid: [{ lagDays: 1, amount: 30 }, { lagDays: 5, amount: 50 }] }]);
    expect(input.taxRows).toEqual([{ dueDay: '2026-12-15', amountUsd: 400 }, { dueDay: '2026-11-05', amountUsd: 250 }]);
    // the check in the window pays its net; each employee then repeats weekly at full cost (last 4 checks)
    expect(input.payroll[0]).toEqual({ payDay: '2026-11-05', cashCostUsd: 450 });
    expect(input.payroll[1]).toEqual({ payDay: '2026-11-13', cashCostUsd: 812.34 });
    const projected = input.payroll.slice(2);
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
      { day: '2026-12-01', amountUsd: 80, customerId: 'm1' }, { day: '2027-01-01', amountUsd: 80, customerId: 'm1' },
      { day: '2026-12-31', amountUsd: 60, customerId: 'm2' }, { day: '2027-01-31', amountUsd: 60, customerId: 'm2' },
    ]);
  });

  test('dues: the verdict is judged as of each billing day, so a change on a later date counts from that date', async () => {
    const { monthlyDuesVerdict, autopayGuard } = require('../services/monthly-dues-eligibility');
    // m1's card expires before January's run; m2's Auto Pay pause ends after December's run; m3 already paid
    // December's dues early (a retry), so the run skips that month
    monthlyDuesVerdict.mockImplementation(async (db, id, { now }) => ({ eligible: !(id === 'm1' && now.toISOString() >= '2027-01') }));
    autopayGuard.mockImplementation((c, when) => (c.id === 'm2' && when.toISOString() < '2026-12-20' ? { event: 'skipped_autopay_paused' } : null));
    monthlyDuesCollected.mockImplementation(async (db, id, when) => id === 'm3' && when.toISOString().startsWith('2026-12'));
    try {
      const database = fakeDb({ tables: { customers: [
        { id: 'm1', billing_mode: 'monthly_membership', monthly_rate: 80, billing_day: 1 },
        { id: 'm2', billing_mode: 'monthly_membership', monthly_rate: 60, billing_day: 15 },
        { id: 'm3', billing_mode: 'monthly_membership', monthly_rate: 40, billing_day: 10 },
      ] } });
      const input = await loadForecastInput({ database, now: NOW, readCashBalances: cashOk, readStripeBalance: async () => ({}) });
      expect(input.dues).toEqual([
        { day: '2026-12-01', amountUsd: 80, customerId: 'm1' }, { day: '2027-01-15', amountUsd: 60, customerId: 'm2' },
        { day: '2026-11-10', amountUsd: 40, customerId: 'm3' }, { day: '2027-01-10', amountUsd: 40, customerId: 'm3' },
      ]);
      // each run is judged on its own morning, Eastern time
      expect(monthlyDuesVerdict.mock.calls.map((c) => [c[1], c[2].now.toISOString()])).toEqual(expect.arrayContaining([
        ['m1', '2026-12-01T12:00:00.000Z'], ['m1', '2027-01-01T12:00:00.000Z'], ['m2', '2027-01-15T12:00:00.000Z'],
      ]));
    } finally {
      monthlyDuesVerdict.mockImplementation(async () => ({ eligible: true }));
      autopayGuard.mockImplementation(() => null);
      monthlyDuesCollected.mockReset().mockResolvedValue(false);
    }
  });
});
