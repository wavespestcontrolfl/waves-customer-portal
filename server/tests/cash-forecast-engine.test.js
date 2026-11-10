/**
 * 13-week cash forecast engine (pure). Synthetic numbers only. Today is Thursday 2026-11-05 (ET), so
 * week 0 is Mon Nov 2 - Sun Nov 8 counting Nov 5-8, and the trailing 8 weeks are Sep 7 - Nov 1.
 */
const { computeForecast, _private } = require('../services/cash-forecast/engine');

const {
  buildWeeks, weekOf, collectionCurve, spread, lander, seasonRatios, occurrences, hireCosts, addBusinessDays,
  classifyLines, spendTotals, findRepeating, merchantKey, monthlyAfter,
} = _private;

// Debit totals per money-out line over the trailing window, the way the engine's context reads them.
const classifySpend = (lines, opts) => spendTotals(classifyLines(lines, opts), opts);

const TODAY = '2026-11-05';

// n visits worth $100 each, watched for `age` days, each paid `paidShare` of its value `lag` days after.
const cohort = ({ n = 20, age = 200, lag = 0, paidShare = 1 } = {}) => Array.from({ length: n }, () => ({
  value: 100, ageDays: age, paid: paidShare > 0 ? [{ lagDays: lag, amount: 100 * paidShare }] : [],
}));

const base = (over = {}) => ({
  today: TODAY,
  opening: { bankUsd: 1000, cardOwedUsd: 0, partial: false },
  stripe: { availableUsd: 0, pendingUsd: 0, payouts: [] },
  visitCohort: cohort(),
  invoiceCohort: cohort(),
  booked: [],
  openInvoices: [],
  dues: [],
  trailing: { visits: 0, workValueUsd: 0, prepaySalesUsd3m: 0 },
  bankLines: [],
  poolAccounts: ['checking-a', 'checking-b'],
  feedCards: ['card-f'],
  payroll: [],
  taxRows: [],
  items: [],
  settings: { last_year_receipts: {} },
  missing: [],
  ...over,
});

describe('weeks (ET, Monday-Sunday)', () => {
  test('week 0 counts today through Sunday; 13 weeks end on a Sunday', () => {
    const weeks = buildWeeks(TODAY);
    expect(weeks).toHaveLength(13);
    expect(weeks[0]).toMatchObject({ start: '2026-11-02', end: '2026-11-08', from: TODAY, days: 4 });
    expect(weeks[1]).toMatchObject({ start: '2026-11-09', from: '2026-11-09', days: 7 });
    expect(weeks[12]).toMatchObject({ start: '2027-01-25', end: '2027-01-31' });
  });

  test('a Sunday today is a one-day week 0; a Monday is a full week', () => {
    expect(buildWeeks('2026-11-08')[0]).toMatchObject({ start: '2026-11-02', days: 1 });
    expect(buildWeeks('2026-11-09')[0]).toMatchObject({ start: '2026-11-09', days: 7 });
  });

  test('the DST change week (Nov 1 2026, Mar 8 2027) still starts on Monday', () => {
    expect(buildWeeks('2026-11-01')[0]).toMatchObject({ start: '2026-10-26', end: '2026-11-01' });
    expect(buildWeeks('2027-03-08')[0]).toMatchObject({ start: '2027-03-08', days: 7 });
  });

  test('days before today or after the window belong to no week', () => {
    const weeks = buildWeeks(TODAY);
    expect(weekOf(weeks, '2026-11-04')).toBeNull();
    expect(weekOf(weeks, TODAY)).toBe(0);
    expect(weekOf(weeks, '2027-01-31')).toBe(12);
    expect(weekOf(weeks, '2027-02-01')).toBeNull();
  });

  test('business days skip the weekend and count from the next day', () => {
    expect(addBusinessDays('2026-11-05', 2)).toBe('2026-11-09'); // Thu -> Mon
    expect(addBusinessDays('2026-11-06', 2)).toBe('2026-11-10'); // Fri -> Tue
    expect(addBusinessDays('2026-11-07', 1)).toBe('2026-11-09'); // Sat -> Mon
  });
});

describe('collection curve (per completed visit, censored by age)', () => {
  test('cash collected per dollar by each lag; unpaid work stays in the denominator', () => {
    const { curve } = collectionCurve([...cohort({ n: 15, lag: 10 }), ...cohort({ n: 5, paidShare: 0 })]);
    expect(curve[9]).toBe(0);
    expect(curve[10]).toBeCloseTo(0.75);
    expect(curve[91]).toBeCloseTo(0.75);
  });

  test('a lag only counts visits watched that long, and too few visits keep the last share', () => {
    // 20 old visits paid at lag 5; 30 young (age 3) unpaid visits must not drag lag 5 down
    const { curve } = collectionCurve([...cohort({ n: 20, lag: 5 }), ...cohort({ n: 30, age: 3, paidShare: 0 })]);
    expect(curve[5]).toBe(1);
    const thin = collectionCurve(cohort({ n: 19, lag: 0 })).curve;
    expect(thin[0]).toBe(0);
  });

  test('the curve never falls', () => {
    const { curve } = collectionCurve([...cohort({ n: 20, age: 10, lag: 0 }), ...cohort({ n: 20, age: 50, paidShare: 0 })]);
    for (let t = 1; t < curve.length; t += 1) expect(curve[t]).toBeGreaterThanOrEqual(curve[t - 1]);
  });

  test('spread lands each share two business days after the payment day', () => {
    const curve = new Array(92).fill(1);
    expect(spread('visits', '2026-11-05', 100, curve, lander())).toEqual([{ day: '2026-11-09', line: 'visits', amount: 100 }]);
  });
});

describe('season (decision 3 A)', () => {
  const trailing = ['2026-09-07', '2026-10-15'];
  const window = ['2026-11-20', '2026-12-20'];
  test('a missing month hides the expected edge and names the months', () => {
    const r = seasonRatios({ '2025-09': 300000 }, trailing, window);
    expect(r.ratioFor).toBeNull();
    expect(r.missingMonths).toEqual(['2025-10', '2025-11', '2025-12']);
  });

  test('ratio = last year daily rate in that month / last year daily rate over the trailing window', () => {
    const r = seasonRatios({ '2025-09': 300000, '2025-10': 310000, '2025-11': 150000, '2025-12': 155000 }, trailing, window);
    // daily: Sep 100, Oct 100, Nov 50, Dec 50 -> ratio 0.5
    expect(r.ratioFor('2026-11-20')).toBeCloseTo(0.5);
    expect(r.ratioFor('2026-12-20')).toBeCloseTo(0.5);
  });
});

describe('bank lines -> money out', () => {
  const opts = { pool: ['checking-a', 'checking-b'], feedCards: ['card-f'], from: '2026-09-07', to: '2026-11-01' };
  let id = 0;
  const line = (over) => { id += 1; return { id: `l${id}`, day: '2026-10-10', direction: 'debit', amount: 50, description: 'SOMETHING', category: null, modeled: false, ...over }; };

  test('a matched transfer between pool accounts cancels; an unmatched one stays as money out', () => {
    const { totals } = classifySpend([
      line({ account: 'checking-a', amount: 500, description: 'ONLINE TRANSFER TO CHK 1111' }),
      line({ account: 'checking-b', amount: 500, direction: 'credit', day: '2026-10-11', description: 'ONLINE TRANSFER FROM CHK 2222' }),
      line({ account: 'checking-a', amount: 300, description: 'TRANSFER TO SAVINGS ELSEWHERE' }),
    ], opts);
    expect(totals.other_spending).toBe(300);
  });

  test('real transfer wording cancels; an unrelated same-amount pair stays in', () => {
    const real = { ...opts, pool: ['capital-one-checking-3965', 'capital-one-checking-3098'] };
    const { totals } = classifySpend([
      line({ account: 'capital-one-checking-3965', amount: 500, description: 'TRANSFER WITHDRAWAL To ....3098' }),
      line({ account: 'capital-one-checking-3098', amount: 500, direction: 'credit', description: 'Capital One Bank' }),
      line({ account: 'capital-one-checking-3098', amount: 250, description: 'Capital One Bank' }),
      line({ account: 'capital-one-checking-3965', amount: 250, direction: 'credit', description: 'TRANSFER DEPOSIT From ....3098' }),
      // a $100 payment out and an unrelated $100 deposit two days apart: no transfer wording, so both stay
      line({ account: 'capital-one-checking-3965', amount: 100, description: 'ZELLE TO SOMEONE' }),
      line({ account: 'capital-one-checking-3098', amount: 100, direction: 'credit', description: 'MOBILE DEPOSIT' }),
      // a transfer that names a third account is money leaving the pool
      line({ account: 'capital-one-checking-3965', amount: 70, description: 'TRANSFER WITHDRAWAL To ....7777' }),
      line({ account: 'capital-one-checking-3098', amount: 70, direction: 'credit', description: 'Capital One Bank' }),
    ], real);
    expect(totals).toEqual({ products_fuel: 0, ai_software: 0, card_payments_off_feed: 0, other_spending: 170 });
  });

  test('a card payment cancels only against a card credit that reads as a payment; "Capital One Bank" is no card payment', () => {
    const { totals } = classifySpend([
      line({ account: 'checking-a', amount: 60, description: 'CAPITAL ONE' }),
      line({ account: 'card-f', amount: 60, direction: 'credit', day: '2026-10-11', description: 'AMAZON REFUND' }),
      line({ account: 'checking-b', amount: 40, description: 'Capital One Bank' }),
    ], opts);
    expect(totals).toEqual({ products_fuel: 0, ai_software: 0, card_payments_off_feed: 60, other_spending: 40 });
  });

  test('a feed-card payment and its card credit both drop out; a payment to a card off the feed is its own line', () => {
    const { totals } = classifySpend([
      line({ account: 'checking-a', amount: 400, description: 'CAPITAL ONE MOBILE PYMT' }),
      line({ account: 'card-f', amount: 400, direction: 'credit', day: '2026-10-12', description: 'CAPITAL ONE MOBILE PYMT' }),
      line({ account: 'checking-b', amount: 900, description: 'CAPITAL ONE MOBILE PYMT' }),
    ], opts);
    expect(totals.card_payments_off_feed).toBe(900);
    expect(totals.other_spending).toBe(0);
  });

  test('categories pick the line; names are the fallback; returned card payments, payroll funding and modeled lines drop out', () => {
    const { totals } = classifySpend([
      line({ account: 'card-f', amount: 120, category: 'Supplies' }),
      line({ account: 'checking-a', amount: 60, category: 'Vehicle Expenses' }),
      line({ account: 'card-f', amount: 200, category: 'Software & Technology' }),
      line({ account: 'checking-b', amount: 10, description: 'ANTHROPIC API' }),
      line({ account: 'card-f', amount: 2675, description: 'RETURNED MOBILE ACH' }),
      line({ account: 'checking-a', amount: 800, description: 'MERCURY TRANSFER PAYROLL' }),
      line({ account: 'checking-a', amount: 700, modeled: true }),
      line({ account: 'other-bank', amount: 999 }),
      line({ account: 'checking-a', amount: 5, day: '2026-11-02' }),
      line({ account: 'checking-a', amount: 7, direction: 'credit', description: 'ZELLE FROM SOMEONE' }),
    ], opts);
    expect(totals).toEqual({ products_fuel: 180, ai_software: 210, card_payments_off_feed: 0, other_spending: 0 });
  });
});

// Step 2c (decision 2 A): a bill the feed shows about once a month, 3 times or more at a steady amount,
// counts on its own day instead of inside the trailing average. Synthetic merchants and amounts only.
describe('repeating bills', () => {
  const pool = ['checking-a', 'checking-b'];
  const feedCards = ['card-f'];
  const WINDOW_END = '2027-01-31';
  let id = 0;
  const debit = (day, amount, description, over = {}) => {
    id += 1;
    return { id: `r${id}`, day, account: 'checking-a', direction: 'debit', amount, description, category: null, modeled: false, ...over };
  };
  const bills = (lines, marks) => findRepeating(classifyLines(lines, { pool, feedCards }), { today: TODAY, windowEnd: WINDOW_END, marks });

  test('the merchant key: the first two words without digits, punctuation, scraps or payment words', () => {
    expect(merchantKey('Cloud Docs_team')).toBe('CLOUD DOCS');
    expect(merchantKey('CLOUD DOCS TEAM 4471')).toBe('CLOUD DOCS');
    expect(merchantKey('ACH DEBIT ACME LOAN PAYMT 0091 WEB ID 77')).toBe('ACME LOAN');
    expect(merchantKey('SQ* B 2210')).toBe('SQ');
    expect(merchantKey('#4410 *')).toBe('');
  });

  test('a monthly bill counts on the same day each month at its usual amount (median of the last 3)', () => {
    const [bill, ...rest] = bills([
      debit('2026-08-07', 360, 'ACME LOAN 1'), debit('2026-09-08', 366, 'ACME LOAN 2'), debit('2026-10-07', 366.5, 'ACME LOAN 3'),
    ]);
    expect(rest).toHaveLength(0);
    expect(bill).toMatchObject({
      key: 'ACME LOAN', label: 'ACME LOAN 3', line: 'other_spending', amount_usd: 366, day_of_month: 7,
      last_day: '2026-10-07', count: 3, days: ['2026-11-07', '2026-12-07', '2027-01-07'], mark: null,
    });
  });

  test('a bill on the 31st lands on the last day of a shorter month', () => {
    expect(monthlyAfter('2026-10-31', WINDOW_END)).toEqual(['2026-11-30', '2026-12-31', '2027-01-31']);
  });

  test('usage charges days apart and weekly fuel at one price are never bills; two debits are not enough', () => {
    const usage = [];
    for (const d of ['2026-08-03', '2026-08-04', '2026-08-09', '2026-09-02', '2026-09-03', '2026-09-08', '2026-10-02', '2026-10-05', '2026-10-06']) usage.push(debit(d, 10, 'MODEL API'));
    const fuel = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']
      .map((d) => debit(d, 40, 'CORNER FUEL 12'));
    expect(bills([...usage, ...fuel, debit('2026-09-15', 25, 'NEW APP'), debit('2026-10-15', 25, 'NEW APP')])).toEqual([]);
  });

  test('two plans from one merchant stay two bills; a bill that grows a little stays one', () => {
    const found = bills([
      debit('2026-08-05', 20, 'TEAM CHAT'), debit('2026-08-20', 60, 'TEAM CHAT'),
      debit('2026-09-05', 20, 'TEAM CHAT'), debit('2026-09-20', 60, 'TEAM CHAT'),
      debit('2026-10-05', 20, 'TEAM CHAT'), debit('2026-10-20', 60, 'TEAM CHAT'),
      debit('2026-08-02', 17, 'CLOUD DOCS'), debit('2026-09-02', 21, 'CLOUD DOCS'), debit('2026-10-02', 24, 'CLOUD DOCS'),
    ]);
    expect(found.map((b) => [b.key, b.amount_usd, b.day_of_month])).toEqual([
      ['CLOUD DOCS', 21, 2], ['TEAM CHAT', 20, 5], ['TEAM CHAT', 60, 20],
    ]);
  });

  test('the latest monthly run counts: an older one-off or a missed month ends it, and leaves those debits out', () => {
    const [bill] = bills([
      debit('2026-07-30', 200, 'AI STUDIO SUB'), debit('2026-07-30', 200, 'AI STUDIO SUB', { id: 'old-twin' }),
      debit('2026-08-21', 200, 'AI STUDIO SUB'), debit('2026-09-21', 200, 'AI STUDIO SUB'), debit('2026-10-21', 200, 'AI STUDIO SUB'),
    ]);
    expect(bill).toMatchObject({ key: 'AI STUDIO', count: 3, days: ['2026-11-21', '2026-12-21', '2027-01-21'] });
    expect(bill.memberIds).not.toContain('old-twin');
    // a missed month (61 days) leaves only two debits after it: no bill, though the merchant is still billing
    expect(bills([debit('2026-07-05', 80, 'NET HOME'), debit('2026-08-05', 80, 'NET HOME'), debit('2026-10-05', 80, 'NET HOME'),
      debit('2026-11-04', 80, 'NET HOME')])).toEqual([]);
  });

  test('a bill due up to 5 days ago that the feed does not show yet counts today; later than that it stopped', () => {
    const [due] = bills([debit('2026-08-02', 30, 'DESK APP'), debit('2026-09-02', 30, 'DESK APP'), debit('2026-10-02', 30, 'DESK APP')]);
    expect(due.days).toEqual(['2026-11-05', '2026-12-02', '2027-01-02']); // Nov 2 is 3 days ago
    expect(bills([debit('2026-07-25', 30, 'OLD APP'), debit('2026-08-25', 30, 'OLD APP'), debit('2026-09-25', 30, 'OLD APP')])).toEqual([]);
  });

  test('card payments, payroll funding, transfers between the pool accounts and modeled lines are never bills', () => {
    const monthly = (description, amount, over = {}) => ['2026-08-10', '2026-09-10', '2026-10-10'].map((d) => debit(d, amount, description, over));
    expect(bills([
      ...monthly('CAPITAL ONE MOBILE PYMT', 510),
      ...monthly('MERCURY TRANSFER PAYROLL', 520),
      ...monthly('IRS USATAXPYMT', 530, { modeled: true }),
      ...monthly('TRANSFER WITHDRAWAL To ....2222', 540),
      ...monthly('TRANSFER DEPOSIT From ....1111', 540, { account: 'checking-b', direction: 'credit' }),
    ])).toEqual([]);
  });

  test('a mark is a label on the bill; the numbers are the same with or without it', () => {
    const lines = () => [debit('2026-08-07', 300, 'ACME LOAN'), debit('2026-09-08', 300, 'ACME LOAN'), debit('2026-10-07', 300, 'ACME LOAN')];
    const marked = computeForecast(base({ bankLines: lines(), marks: { 'ACME LOAN': 'household' } }));
    const plain = computeForecast(base({ bankLines: lines() }));
    expect(marked.repeating[0].mark).toBe('household');
    expect(marked.weeks[0].bills[0].mark).toBe('household');
    expect(marked.weeks.map((w) => w.end_booked)).toEqual(plain.weeks.map((w) => w.end_booked));
  });

  test('a bill leaves the trailing average and counts once, on its own day, with its own line', () => {
    const r = computeForecast(base({
      bankLines: [
        debit('2026-08-10', 300, 'ACME LOAN'), debit('2026-09-10', 300, 'ACME LOAN'), debit('2026-10-10', 300, 'ACME LOAN'),
        debit('2026-10-01', 800, 'POWER CO'),
      ],
    }));
    expect(r.method.weekly_usd.other_spending).toBe(100); // the $800 only: the bill's two trailing debits are out
    expect(r.weeks[1].money_out).toMatchObject({ other_spending: 100, repeating_bills: 300 }); // Nov 9-15 holds Nov 10
    expect(r.weeks[2].money_out.repeating_bills).toBe(0);
    expect(r.weeks[1].bills).toEqual([{ key: 'ACME LOAN', label: 'ACME LOAN', day: '2026-11-10', amount_usd: 300, mark: null }]);
    expect(r.repeating).toEqual([expect.objectContaining({ key: 'ACME LOAN', next_day: '2026-11-10', count: 3 })]);
    expect(r.repeating[0]).not.toHaveProperty('memberIds');
    expect(r.method.repeating_bills).toBe(1);
    // over the window: 3 bill days at $300, and the $800 line at $100 a week
    const out = r.weeks.reduce((sum, w) => sum + w.money_out.repeating_bills + w.money_out.other_spending, 0);
    expect(out).toBeCloseTo(900 + 100 * (4 / 7) + 100 * 12, 1); // week rows are rounded to cents
  });

  test('a fixed monthly vehicle bill leaves products per visit and counts on its day', () => {
    const r = computeForecast(base({
      trailing: { visits: 40, workValueUsd: 0, prepaySalesUsd3m: 0 },
      bankLines: [
        debit('2026-08-12', 450, 'VAN LEASE', { category: 'Vehicle Expenses' }), debit('2026-09-12', 450, 'VAN LEASE', { category: 'Vehicle Expenses' }),
        debit('2026-10-12', 450, 'VAN LEASE', { category: 'Vehicle Expenses' }),
        debit('2026-10-02', 400, 'X', { account: 'card-f', category: 'Supplies' }),
      ],
    }));
    expect(r.method.products_fuel_per_visit_usd).toBe(10); // $400 / 40 visits; the lease is out
    expect(r.repeating.map((b) => [b.key, b.line, b.next_day])).toEqual([['VAN LEASE', 'products_fuel', '2026-11-12']]);
  });
});

describe('planned items', () => {
  test('weekly and biweekly step from the first date into the window; once in the past is gone', () => {
    expect(occurrences({ cadence: 'weekly', first_date: '2026-10-29' }, TODAY, '2026-11-20')).toEqual(['2026-11-05', '2026-11-12', '2026-11-19']);
    expect(occurrences({ cadence: 'biweekly', first_date: '2026-10-29', last_date: '2026-12-01' }, TODAY, '2027-01-31')).toEqual(['2026-11-12', '2026-11-26']);
    expect(occurrences({ cadence: 'once', first_date: '2026-11-01' }, TODAY, '2027-01-31')).toEqual([]);
  });

  test('monthly keeps the day of the month, or the last day of a shorter month', () => {
    expect(occurrences({ cadence: 'monthly', first_date: '2026-10-31' }, TODAY, '2027-03-01')).toEqual(['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']);
  });

  test('a hire costs gross + 7.65% + 3.3% on the first $7,000 of each calendar year', () => {
    const costs = hireCosts({ amount_cents: 400000 }, ['2026-12-24', '2026-12-31', '2027-01-07']);
    expect(costs.map((c) => c.usd)).toEqual([4000 + 306 + 132, 4000 + 306 + 99, 4000 + 306 + 132]);
  });

  test('checks earlier in the same year already used part of the $7,000', () => {
    const costs = hireCosts({ amount_cents: 400000 }, ['2026-12-24'], ['2026-12-17']);
    expect(costs.map((c) => c.usd)).toEqual([4000 + 306 + 99]); // $3,000 of the cap left
  });
});

describe('computeForecast', () => {
  test('a booked visit lands through the curve; card money arrives 2 business days later', () => {
    const r = computeForecast(base({ booked: [{ day: '2026-11-06', value: 100 }] }));
    expect(r.weeks[0].money_in.visits).toBe(0);
    expect(r.weeks[1].money_in.visits).toBe(100); // Fri Nov 6 -> Tue Nov 10
    expect(r.weeks[1].end_booked).toBe(1100);
  });

  test('Stripe available +1 business day, pending +2, payouts on their day; one still on the way past its day is listed, not counted', () => {
    const r = computeForecast(base({ stripe: { availableUsd: 10, pendingUsd: 20, payouts: [
      { amountUsd: 30, arrivalDay: '2026-11-05' }, { amountUsd: 40, arrivalDay: '2026-11-04' }, { amountUsd: 50, arrivalDay: '2026-11-10' },
      { amountUsd: 5, arrivalDay: '2026-11-02' },
    ] } }));
    expect(r.weeks[0].money_in.stripe).toBe(40); // available Fri + payout today
    expect(r.weeks[1].money_in.stripe).toBe(70); // pending Mon + payout Tue
    // it may already be in the bank balance, so it is never counted twice
    expect(r.missing).toContainEqual({ kind: 'payouts_overdue', count: 2, usd: 45, first_day: '2026-11-02' });
  });

  test('open invoices: the share still collectable at their age; a 92+ day invoice is listed apart', () => {
    const invoiceCohort = [...cohort({ n: 10, lag: 5 }), ...cohort({ n: 10, lag: 20 })];
    const r = computeForecast(base({ invoiceCohort, openInvoices: [{ amountUsd: 100, ageDays: 10 }, { amountUsd: 70, ageDays: 120 }] }));
    // open at age 10: half the cohort is paid by 5; the rest pays at lag 20 -> 10 days from now (Sun Nov 15) + 2 bd = Tue Nov 17
    expect(r.weeks[2].money_in.invoices).toBe(100);
    expect(r.missing).toContainEqual({ kind: 'invoices_late_beyond', count: 1, usd: 70 });
  });

  test('an open invoice unpaid when today began can still be paid today', () => {
    const r = computeForecast(base({ invoiceCohort: cohort({ n: 20, lag: 5 }), openInvoices: [{ amountUsd: 90, ageDays: 5 }] }));
    // lag 5 is today: paid Thu Nov 5, in the bank Mon Nov 9
    expect(r.weeks[1].money_in.invoices).toBe(90);
  });

  test('dues count from tomorrow, not today', () => {
    const r = computeForecast(base({ dues: [{ day: TODAY, amountUsd: 80 }, { day: '2026-12-01', amountUsd: 80 }] }));
    const total = r.weeks.reduce((s, w) => s + w.money_in.dues, 0);
    expect(total).toBe(80);
  });

  test('no last-year months: booked edge only, expected null, months listed', () => {
    const r = computeForecast(base());
    expect(r.expected_available).toBe(false);
    expect(r.weeks[0].end_expected).toBeNull();
    expect(r.missing).toContainEqual({ kind: 'last_year_months', months: ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01'] });
  });

  test('an invoiced booked visit is still booked work: new work never refills it', () => {
    const flat = { '2025-09': 300000, '2025-10': 310000, '2025-11': 300000, '2025-12': 310000, '2026-01': 310000 };
    const r = computeForecast(base({
      trailing: { visits: 0, workValueUsd: 5600, prepaySalesUsd3m: 0 }, // $100 a day
      settings: { last_year_receipts: flat },
      booked: [{ day: '2026-11-10', value: 0, work: 1000 }], // invoiced: no cash from the visit itself
    }));
    expect(r.weeks[2].money_in.new_work).toBe(300); // week 1 has no gap, as if the visit were not invoiced
    expect(r.weeks[1].money_in.visits).toBe(0);
  });

  test('with last-year months: new work fills the gap above booked work, never below it', () => {
    const flat = { '2025-09': 300000, '2025-10': 310000, '2025-11': 300000, '2025-12': 310000, '2026-01': 310000 };
    const r = computeForecast(base({
      trailing: { visits: 0, workValueUsd: 5600, prepaySalesUsd3m: 0 }, // $100 a day
      settings: { last_year_receipts: flat },
      booked: [{ day: '2026-11-10', value: 1000 }],
    }));
    expect(r.expected_available).toBe(true);
    // cash lands 2 business days after the work: week 0's four days ($400) arrive in week 1; week 1 has
    // no gap (booked $1,000 covers the $700 wanted), so week 2 gets only its own Mon-Wed ($300)
    expect(r.weeks[1].money_in.new_work).toBe(400);
    expect(r.weeks[2].money_in.new_work).toBe(300);
    expect(r.weeks[3].money_in.new_work).toBe(700);
    expect(r.weeks[12].end_expected).toBeGreaterThan(r.weeks[12].end_booked);
  });

  test('money out: weekly lines from 8 trailing weeks, products per visit, card owed in week 0', () => {
    const r = computeForecast(base({
      opening: { bankUsd: 1000, cardOwedUsd: 250, partial: false },
      trailing: { visits: 40, workValueUsd: 0, prepaySalesUsd3m: 0 },
      bankLines: [
        { id: 'a', day: '2026-10-01', account: 'checking-a', direction: 'debit', amount: 800, description: 'POWER CO', category: null },
        { id: 'b', day: '2026-10-02', account: 'card-f', direction: 'debit', amount: 400, description: 'X', category: 'Supplies' },
      ],
      booked: [{ day: '2026-11-11', value: 0 }, { day: '2026-11-12', value: 0 }],
    }));
    expect(r.weeks[0].money_out.card_owed).toBe(250);
    expect(r.weeks[1].money_out.other_spending).toBe(100); // 800 / 8 weeks
    expect(r.weeks[0].money_out.other_spending).toBeCloseTo(100 * 4 / 7, 2);
    expect(r.weeks[1].money_out.products_fuel).toBe(20); // $400 / 40 visits x 2 booked
    expect(r.method.products_fuel_per_visit_usd).toBe(10);
  });

  test('a card payoff plan replaces the off-feed card payment line; without one the tab asks for it', () => {
    const lines = [{ id: 'p', day: '2026-10-05', account: 'checking-b', direction: 'debit', amount: 1600, description: 'CAPITAL ONE ONLINE PMT', category: null }];
    const without = computeForecast(base({ bankLines: lines }));
    expect(without.weeks[1].money_out.card_payments_off_feed).toBe(200);
    expect(without.missing).toContainEqual({ kind: 'card_payoff_plan', weekly_usd: 200 });
    const withPlan = computeForecast(base({ bankLines: lines, items: [
      { kind: 'card_payoff', label: 'Old card', amount_cents: 50000, cadence: 'monthly', first_date: '2026-11-20', active: true },
    ] }));
    // the plan starts Fri Nov 20: the trailing line still covers the days before it
    expect(withPlan.weeks[1].money_out.card_payments_off_feed).toBe(200);
    expect(withPlan.weeks[2].money_out.card_payments_off_feed).toBeCloseTo(200 * 4 / 7, 2); // Nov 16-19
    expect(withPlan.weeks[3].money_out.card_payments_off_feed).toBe(0);
    expect(withPlan.weeks[2].money_out.planned).toBe(500);
    expect(withPlan.missing.find((m) => m.kind === 'card_payoff_plan')).toBeUndefined();
  });

  test('a hire is its own line to its last date; a real check (maybe another employee) never cancels it, but asks', () => {
    const r = computeForecast(base({
      items: [{ kind: 'hire', label: 'Tech', amount_cents: 100000, cadence: 'weekly', first_date: '2027-01-08', active: true }],
      payroll: [{ payDay: '2027-01-15', cashCostUsd: 1200 }],
    }));
    const hire = r.weeks.map((w) => w.money_out.hire);
    expect(hire.filter((h) => h > 0)).toHaveLength(4); // Jan 8, 15, 22, 29
    expect(r.weeks[10].money_out.payroll).toBe(1200);
    expect(r.missing).toContainEqual({ kind: 'hire_overlaps_pay_runs', label: 'Tech', first_pay_day: '2027-01-15' });
    expect(r.weeks[12].end_booked_with_hire).toBeLessThan(r.weeks[12].end_booked);
    expect(r.lowest.booked_with_hire.week_start).toBe('2027-01-25');
  });

  test('after a payoff plan ends, the trailing card payment line comes back', () => {
    const lines = [{ id: 'p', day: '2026-10-05', account: 'checking-b', direction: 'debit', amount: 1600, description: 'CAPITAL ONE', category: null }];
    const r = computeForecast(base({ bankLines: lines, items: [
      { kind: 'card_payoff', label: 'Short plan', amount_cents: 50000, cadence: 'once', first_date: '2026-11-09', last_date: '2026-11-15', active: true },
    ] }));
    expect(r.weeks[1].money_out.card_payments_off_feed).toBe(0); // Nov 9-15: the plan
    expect(r.weeks[2].money_out.card_payments_off_feed).toBe(200); // after it
  });

  test('a one-time payoff with no last date covers its own day only, then the card payment line comes back', () => {
    const lines = [{ id: 'p', day: '2026-10-05', account: 'checking-b', direction: 'debit', amount: 1400, description: 'CAPITAL ONE', category: null }];
    const r = computeForecast(base({ bankLines: lines, items: [
      { kind: 'card_payoff', label: 'Lump payoff', amount_cents: 300000, cadence: 'once', first_date: '2026-11-10', last_date: null, active: true },
    ] }));
    expect(r.weeks[1].money_out.card_payments_off_feed).toBe(150); // Nov 9-15 less Nov 10 (175 a week, 25 a day)
    expect(r.weeks[2].money_out.card_payments_off_feed).toBe(175);
    expect(r.weeks[1].money_out.planned).toBe(3000);
  });

  test('a payoff plan that has ended leaves the card payment line in', () => {
    const lines = [{ id: 'p', day: '2026-10-05', account: 'checking-b', direction: 'debit', amount: 1600, description: 'CAPITAL ONE', category: null }];
    const r = computeForecast(base({ bankLines: lines, items: [
      { kind: 'card_payoff', label: 'Old plan', amount_cents: 50000, cadence: 'monthly', first_date: '2026-08-01', last_date: '2026-10-31', active: true },
    ] }));
    expect(r.weeks[1].money_out.card_payments_off_feed).toBe(200);
    expect(r.missing).toContainEqual({ kind: 'card_payoff_plan', weekly_usd: 200 });
  });

  test('no live balance: every end balance is a change from today', () => {
    const r = computeForecast(base({ opening: { bankUsd: null, cardOwedUsd: 0, partial: true }, booked: [{ day: '2026-11-06', value: 100 }] }));
    expect(r.opening).toMatchObject({ bank_usd: null, partial: true });
    expect(r.weeks[1].end_booked).toBe(100);
  });
});
