/**
 * Bug fixed by migration 20260924000021 (confirmed in prod 2026-09-24):
 * `payments_payment_method_id_foreign` carried no ON DELETE action, so
 * StripeService.removeCard's `payment_methods` delete threw a foreign-key
 * violation for any card that had ever taken a payment — AFTER the Stripe
 * detach already ran, leaving a DB row pointing at a detached Stripe PM.
 * 62 distinct payment methods in prod had payments rows and were stuck.
 *
 * This proves against a real Postgres schema that a payment method with a
 * payments row can now be removed end-to-end through StripeService.removeCard,
 * that the payment row survives with its card_brand/card_last_four snapshot
 * intact, and that only its payment_method_id pointer goes NULL — mirroring
 * the other four FKs onto payment_methods, which were already ON DELETE
 * SET NULL. Skips cleanly without DATABASE_URL — the `const SKIP =
 * !process.env.DATABASE_URL` convention the CI workflow's database-enabled
 * step discovers by grep (.github/workflows/tests.yml) and runs with
 * DATABASE_URL set against the migrated database.
 */
const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

(SKIP ? describe.skip : describe)('payment method removal with an existing payments row (real Postgres)', () => {
  let db;
  let StripeService;

  beforeAll(() => {
    db = require('../models/db');
    StripeService = require('../services/stripe');
  });
  afterAll(async () => { await db.destroy(); });

  test('the snapshot trigger is installed by a migration that sorts before the SET NULL flip (GH codex r6 P2)', async () => {
    const fs = require('fs');
    const path = require('path');
    const files = fs.readdirSync(path.join(__dirname, '../models/migrations')).sort();
    const guard = files.indexOf('20260924000019_payments_method_snapshot_before_set_null.js');
    const flip = files.indexOf('20260924000021_payments_payment_method_set_null.js');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(flip);
    const { rows } = await db.raw(`SELECT 1 FROM pg_trigger WHERE tgname = 'payment_methods_snapshot_before_delete'`);
    expect(rows).toHaveLength(1);
  });

  test('payments_payment_method_id_foreign is ON DELETE SET NULL', async () => {
    const { rows } = await db.raw(`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = 'payments_payment_method_id_foreign'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toMatch(/ON DELETE SET NULL/);
  });

  test('removeCard succeeds for a card with a payments row; the payment keeps its snapshot with payment_method_id nulled', async () => {
    const ROLLBACK = new Error('rollback-sentinel');
    let result;
    await db.transaction(async (trx) => {
      const [customer] = await trx('customers')
        .insert({ first_name: 'FkProbe', last_name: 'Card', phone: '+15550001234' })
        .returning('id');
      const customerId = customer.id ?? customer;

      // No stripe_payment_method_id → StripeService.removeCard takes the
      // "Fallback — just remove from DB" branch (no live Stripe call needed
      // to prove the FK behavior).
      const [method] = await trx('payment_methods')
        .insert({
          customer_id: customerId, processor: 'stripe', method_type: 'card',
          card_brand: 'VISA', last_four: '4242',
        })
        .returning('id');
      const methodId = method.id ?? method;

      const [payment] = await trx('payments')
        .insert({
          customer_id: customerId, payment_method_id: methodId,
          payment_date: '2026-09-24', amount: '42.50', status: 'paid',
          card_brand: 'VISA', card_last_four: '4242',
        })
        .returning('id');
      const paymentId = payment.id ?? payment;

      // Exercises the real production removal path — this used to throw
      // "violates foreign key constraint payments_payment_method_id_foreign".
      await expect(StripeService.removeCard(customerId, methodId, { cascadeAutopay: false, db: trx }))
        .resolves.toEqual({ success: true });

      const methodRow = await trx('payment_methods').where({ id: methodId }).first();
      const paymentRow = await trx('payments').where({ id: paymentId }).first();

      result = {
        methodGone: !methodRow,
        payment: paymentRow && {
          payment_method_id: paymentRow.payment_method_id,
          amount: paymentRow.amount,
          status: paymentRow.status,
          card_brand: paymentRow.card_brand,
          card_last_four: paymentRow.card_last_four,
        },
      };
      throw ROLLBACK;
    }).catch((err) => { if (err !== ROLLBACK) throw err; });

    expect(result.methodGone).toBe(true);
    expect(result.payment).toEqual({
      payment_method_id: null,
      amount: '42.50',
      status: 'paid',
      card_brand: 'VISA',
      card_last_four: '4242',
    });
  });

  test('payment history falls back to the charge-time snapshot once the method is removed (GH codex r1 P2)', async () => {
    // getPaymentHistory reads on the global pool, so these rows are
    // committed and removed in finally.
    const [customer] = await db('customers')
      .insert({ first_name: 'FkProbe', last_name: 'History', phone: '+15550001235' })
      .returning('id');
    const customerId = customer.id ?? customer;
    try {
      const [method] = await db('payment_methods')
        .insert({ customer_id: customerId, processor: 'stripe', method_type: 'card', card_brand: 'VISA', last_four: '1310' })
        .returning('id');
      await db('payments').insert({
        customer_id: customerId, payment_method_id: method.id ?? method,
        payment_date: '2026-09-03', amount: '102.33', status: 'paid',
        card_brand: 'VISA', card_last_four: '1310',
      });
      await StripeService.removeCard(customerId, method.id ?? method, { cascadeAutopay: false });

      const history = await StripeService.getPaymentHistory(customerId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ payment_method_id: null, card_brand: 'VISA', last_four: '1310' });
    } finally {
      await db('payments').where({ customer_id: customerId }).del();
      await db('payment_methods').where({ customer_id: customerId }).del();
      await db('customers').where({ id: customerId }).del();
    }
  });

  test('snapshot backfill fills a NULL card_last_four from the linked method and never overwrites (GH codex r2 P2)', async () => {
    const migration = require('../models/migrations/20260924000031_payments_card_snapshot_backfill');
    const ROLLBACK = new Error('rollback-sentinel');
    let rows;
    await db.transaction(async (trx) => {
      const [customer] = await trx('customers')
        .insert({ first_name: 'FkProbe', last_name: 'Backfill', phone: '+15550001236' })
        .returning('id');
      const customerId = customer.id ?? customer;
      const [method] = await trx('payment_methods')
        .insert({ customer_id: customerId, processor: 'stripe', method_type: 'card', card_brand: 'VISA', last_four: '1310' })
        .returning('id');
      const methodId = method.id ?? method;
      const base = { customer_id: customerId, payment_method_id: methodId, payment_date: '2026-09-03', amount: '10.00', status: 'paid' };
      await trx('payments').insert([
        { ...base, description: 'missing', card_brand: 'VISA', card_last_four: null },
        { ...base, description: 'kept', card_brand: 'MASTERCARD', card_last_four: '9999' },
      ]);
      await migration.up(trx);
      rows = await trx('payments').where({ customer_id: customerId }).orderBy('description')
        .select('description', 'card_brand', 'card_last_four');
      throw ROLLBACK;
    }).catch((err) => { if (err !== ROLLBACK) throw err; });

    expect(rows).toEqual([
      { description: 'kept', card_brand: 'MASTERCARD', card_last_four: '9999' },
      { description: 'missing', card_brand: 'VISA', card_last_four: '1310' },
    ]);
  });

  test('removing a bank method snapshots its tender onto a bare (failed-attempt) payment row (GH codex r3 P2 x2)', async () => {
    const [customer] = await db('customers')
      .insert({ first_name: 'FkProbe', last_name: 'Ach', phone: '+15550001237' })
      .returning('id');
    const customerId = customer.id ?? customer;
    try {
      const [method] = await db('payment_methods')
        .insert({
          customer_id: customerId, processor: 'stripe', method_type: 'ach',
          bank_name: 'FIFTH THIRD BANK', last_four: '2017', bank_last_four: '2017',
        })
        .returning('id');
      // A failed-attempt writer that stores only the pointer — no snapshot.
      await db('payments').insert({
        customer_id: customerId, payment_method_id: method.id ?? method,
        payment_date: '2026-09-10', amount: '99.00', status: 'failed',
      });
      await StripeService.removeCard(customerId, method.id ?? method, { cascadeAutopay: false });

      const [row] = await StripeService.getPaymentHistory(customerId);
      expect(row).toMatchObject({
        payment_method_id: null,
        method_type: 'ach',
        bank_name: 'FIFTH THIRD BANK',
        last_four: '2017',
        status: 'failed',
      });
    } finally {
      await db('payments').where({ customer_id: customerId }).del();
      await db('payment_methods').where({ customer_id: customerId }).del();
      await db('customers').where({ id: customerId }).del();
    }
  });
});
