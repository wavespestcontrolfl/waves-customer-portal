// void_invoice's payment-evidence read (disqualifyingPayment) against REAL PostgreSQL: one existence query, status filter
// in SQL, no limit. A pile of failed attempts must not hide a later disputed payment (Codex on #6382). Uses a TEMP
// payments table on one connection, so nothing in the database is touched.
//
// Self-skips without REPAIR_TEST_DATABASE_URL set to a local disposable database, e.g.:
//   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
//     npm exec -- jest --runInBand intelligence-bar-void-invoice-payments-postgres.test.js
const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

let mockKnex;
jest.mock('../models/db', () => (...args) => mockKnex(...args));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

postgres('disqualifyingPayment — real Postgres', () => {
  let knex;
  let disqualifyingPayment;
  const INV = '00000000-0000-4000-8000-0000000000a1';
  const OTHER = '00000000-0000-4000-8000-0000000000a2';
  const invoice = { id: INV, invoice_number: 'WPC-2099-0001', stripe_payment_intent_id: null, stripe_charge_id: null };

  beforeAll(async () => {
    const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('This test requires a local disposable database');
    knex = require('knex')({ client: 'pg', connection: process.env.REPAIR_TEST_DATABASE_URL, pool: { min: 1, max: 1 } });
    mockKnex = knex;
    await knex.raw('CREATE TEMP TABLE payments (id serial PRIMARY KEY, status text, metadata jsonb, stripe_payment_intent_id text, stripe_charge_id text, description text)');
    ({ disqualifyingPayment } = require('../services/intelligence-bar/void-invoice-tools'));
  });
  afterAll(async () => { if (knex) await knex.destroy(); });
  beforeEach(async () => { await knex.raw('TRUNCATE payments'); });

  const failed = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ status: 'failed', metadata: JSON.stringify({ invoice_id: INV }), stripe_payment_intent_id: `pi_f${i}`, ...extra }));

  test('30 failed attempts and one disputed payment: found', async () => {
    await knex('payments').insert([...failed(30), { status: 'disputed', metadata: JSON.stringify({ invoice_id: INV }), stripe_payment_intent_id: 'pi_d' }]);
    expect(await disqualifyingPayment(invoice)).toMatchObject({ status: 'disputed' });
  });

  test('only failed (with a PaymentIntent) and canceled attempts: none', async () => {
    await knex('payments').insert([...failed(30), { status: 'canceled', metadata: JSON.stringify({ invoice_id: INV }), stripe_payment_intent_id: 'pi_c' }]);
    expect(await disqualifyingPayment(invoice)).toBeUndefined();
  });

  test('a failed row with no PaymentIntent counts as money (the outcome may be unknown)', async () => {
    await knex('payments').insert([{ status: 'failed', metadata: JSON.stringify({ invoice_id: INV }), stripe_payment_intent_id: null }]);
    expect(await disqualifyingPayment(invoice)).toMatchObject({ status: 'failed' });
  });

  test('paid, processing and refunded rows are found; another invoice’s rows are not', async () => {
    for (const status of ['paid', 'processing', 'refunded']) {
      await knex('payments').insert([{ status, metadata: JSON.stringify({ invoice_id: INV }) }]);
      expect(await disqualifyingPayment(invoice)).toMatchObject({ status });
      await knex.raw('TRUNCATE payments');
    }
    await knex('payments').insert([{ status: 'paid', metadata: JSON.stringify({ invoice_id: OTHER }) }]);
    expect(await disqualifyingPayment(invoice)).toBeUndefined();
  });

  test('the invoice’s PaymentIntent, charge id and manual-payment description link a row too', async () => {
    await knex('payments').insert([{ status: 'paid', metadata: null, stripe_payment_intent_id: 'pi_inv' }]);
    expect(await disqualifyingPayment({ ...invoice, stripe_payment_intent_id: 'pi_inv' })).toMatchObject({ status: 'paid' });
    await knex.raw('TRUNCATE payments');
    await knex('payments').insert([{ status: 'paid', metadata: null, description: 'Invoice WPC-2099-0001 — Zelle' }]);
    expect(await disqualifyingPayment(invoice)).toMatchObject({ status: 'paid' });
  });
});
