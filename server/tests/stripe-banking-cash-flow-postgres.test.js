// Real migrated PostgreSQL, synthetic rows, rolled back after every test.
// Runs in the existing DB-gated CI step.
//
// Banking cash flow (StripeBanking.getCashFlow): the SQL a mocked suite cannot
// prove. The daily payout and fee queries used to bind the time zone twice
// (once in SELECT, once in GROUP BY); Postgres refuses that query, and a catch
// turned the refusal into days with no payouts and no fees. Now every query
// runs, a payout's arrival marker keeps its UTC calendar day, a fee keeps its
// Eastern day in the filter and the buckets, and a failed query fails the
// report instead of reading as zero.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// A far-future window no seeded row reaches.
const DAY = '2031-07-21';

postgres('banking cash flow against migrated PostgreSQL', () => {
  let database;
  let trx;
  let banking;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local or CI database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
    banking = require('../services/stripe-banking');
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    // Stripe's arrival_date: a calendar-day marker at midnight UTC.
    await trx('stripe_payouts').insert([
      { status: 'paid', arrival_date: `${DAY}T00:00:00Z`, amount: 140 },
      { status: 'canceled', arrival_date: `${DAY}T00:00:00Z`, amount: 500 },
      { status: 'paid', arrival_date: '2031-07-22T00:00:00Z', amount: 60 },
    ]);
    // created_at_stripe is a real instant. 02:00Z on the 21st is 10 PM ET on
    // the 20th; 03:30Z on the 22nd is 11:30 PM ET on the 21st.
    await trx('stripe_payout_transactions').insert([
      { created_at_stripe: `${DAY}T02:00:00Z`, fee: 1.5 },
      { created_at_stripe: `${DAY}T15:00:00Z`, fee: 2.5 },
      { created_at_stripe: '2031-07-22T03:30:00Z', fee: 0.75 },
    ]);
    await trx('expenses').insert({ description: 'Synthetic supplies', amount: 30, expense_date: DAY });
  });

  afterEach(async () => {
    await trx.rollback();
    require('../models/db').connection = database;
  });

  afterAll(async () => {
    await database.destroy();
  });

  test('a payout counts on its arrival day and a fee on its Eastern day, in the buckets and the summary', async () => {
    const report = await banking.getCashFlow(DAY, DAY);
    expect(report.daily).toEqual([
      { date: DAY, revenue: 0, expenses: 30, fees: 3.25, payouts: 140 },
    ]);
    expect(report.summary).toMatchObject({
      total_expenses: 30,
      stripe_fees: 3.25,
      total_payouts: 140,
      payout_count: 1,
    });
  });

  test('a wider range puts each row on its own day and nothing outside the range', async () => {
    const report = await banking.getCashFlow('2031-07-20', '2031-07-22');
    expect(report.daily.map(d => [d.date, d.fees, d.payouts])).toEqual([
      ['2031-07-20', 1.5, 0],
      [DAY, 3.25, 140],
      ['2031-07-22', 0, 60],
    ]);
    expect(report.summary).toMatchObject({ stripe_fees: 4.75, total_payouts: 200, payout_count: 2 });
  });

  test('a failed source query fails the report instead of reading as zero', async () => {
    await trx.raw('SAVEPOINT before_outage');
    await trx.raw('ALTER TABLE stripe_payout_transactions RENAME TO stripe_payout_transactions_unavailable');
    await expect(banking.getCashFlow(DAY, DAY)).rejects.toThrow();
    await trx.raw('ROLLBACK TO SAVEPOINT before_outage');
  });
});
