// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// Runs in the existing DB-gated CI step or against a local disposable database.
//
// The dashboard's cash revenue (Revenue MTD, its daily chart, /compare) must
// follow the shared internal-test-customer rule (services/internal-test-
// customers.js) on BOTH branches: the payments ledger and the paid-Stripe-
// invoice gap fallback. A payer statement settlement is a customer_id NULL
// payments row and must stay counted (DECISIONS.md 2026-06-21, payer P3) —
// the NOT EXISTS shape keeps it, where a plain join would drop it. Only a real
// database proves that NULL case; a fake Knex chain cannot.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');
const { INTERNAL_TEST_CUSTOMERS } = require('../services/internal-test-customers');

postgres('dashboard cash revenue against migrated PostgreSQL', () => {
  let database;
  let trx;
  let paidRevenueTotal;
  let paidRevenueDaily;
  // An old day no migration seed writes payments or invoices on; the
  // assertions are deltas anyway.
  const DAY = '2003-02-11';

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
    ({ paidRevenueTotal, paidRevenueDaily } = require('../routes/admin-dashboard')._internals);
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
  });
  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function customer(firstName, lastName) {
    const id = randomUUID();
    await trx('customers').insert({
      id, first_name: firstName, last_name: lastName,
      email: `${id}@example.invalid`, phone: `fixture-${id.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000',
      active: true, pipeline_stage: 'active_customer', monthly_rate: 0,
    });
    return id;
  }

  // A paid Stripe invoice with no payments row for its PaymentIntent: the
  // dashboard's gap fallback counts it (net of applied credit).
  function gapInvoice(customerId, total) {
    const id = randomUUID();
    return {
      id, customer_id: customerId, invoice_number: `FIX-${id.slice(0, 8)}`,
      token: randomUUID().replace(/-/g, ''), status: 'paid', processor: 'stripe',
      total, stripe_payment_intent_id: `pi_fixture_${id.slice(0, 8)}`,
      paid_at: `${DAY}T15:00:00Z`,
    };
  }

  async function dayTotal() {
    const total = await paidRevenueTotal(DAY, DAY);
    const daily = await paidRevenueDaily(DAY, DAY);
    return { total, daily: daily.find((row) => row.date === DAY)?.total || 0 };
  }

  test('drops internal test cash on both branches and keeps ordinary and payer-settlement cash', async () => {
    expect(INTERNAL_TEST_CUSTOMERS.length).toBeGreaterThan(0);
    const before = await dayTotal();

    // The rule matches the lowercased full name, so case must not matter.
    const [first, ...rest] = INTERNAL_TEST_CUSTOMERS[0].split(' ');
    const internal = await customer(first.toUpperCase(), rest.join(' '));
    const ordinary = await customer('Synthetic', 'Fixture');
    const [payer] = await trx('payers')
      .insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true })
      .returning('id');
    await trx('payments').insert([
      { customer_id: ordinary, payment_date: DAY, amount: 100, status: 'paid' },
      { customer_id: internal, payment_date: DAY, amount: 40, status: 'paid' },
      { customer_id: null, payer_id: payer.id, payment_date: DAY, amount: 25, status: 'paid' },
    ]);
    await trx('invoices').insert([gapInvoice(ordinary, 20), gapInvoice(internal, 30)]);

    const after = await dayTotal();
    // 100 ordinary + 25 payer settlement + 20 ordinary gap; the internal 40 and 30 drop.
    expect(after.total - before.total).toBeCloseTo(145, 2);
    expect(after.daily - before.daily).toBeCloseTo(145, 2);
  });
});
