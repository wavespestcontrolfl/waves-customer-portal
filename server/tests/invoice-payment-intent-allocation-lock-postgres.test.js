// Real PostgreSQL regression coverage for the invoice/PaymentIntent lock
// boundary. A shared PI is mutable as one allocation: staff settlement,
// checkout finalize and void must lock every stamped member in canonical id
// order before they cancel the provider session or mutate sibling stamps.
const { randomUUID } = require('node:crypto');
const knex = require('knex');

const connection = process.env.DATABASE_URL;
const postgres = connection ? describe : describe.skip;
jest.setTimeout(30000);

postgres('invoice PaymentIntent allocation locking', () => {
  let database;
  let InvoiceService;
  let StripeService;
  let customerId;
  let invoiceIds;
  let piId;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(() => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ciTest = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ciTest) {
      throw new Error('Use a verified, task-private QA database or the isolated CI database');
    }
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 6 } });
    InvoiceService = require('../services/invoice');
    StripeService = require('../services/stripe');
  });

  beforeEach(async () => {
    customerId = randomUUID();
    invoiceIds = [randomUUID(), randomUUID()].sort();
    piId = `pi_lock_${randomUUID().replaceAll('-', '')}`;
    await database('customers').insert({
      id: customerId,
      first_name: 'Allocation',
      last_name: 'Lock',
      phone: '+12025550173',
      email: `${customerId}@example.invalid`,
    });
    await database('invoices').insert(invoiceIds.map((id, index) => ({
      id,
      customer_id: customerId,
      invoice_number: `TEST-ALLOC-${id.slice(0, 8)}`,
      token: randomUUID(),
      status: index ? 'sent' : 'viewed',
      subtotal: 100,
      total: 100,
      line_items: '[]',
      stripe_payment_intent_id: piId,
    })));
  });

  afterEach(async () => {
    await database('invoices').whereIn('id', invoiceIds || []).del().catch(() => {});
    if (customerId) await database('customers').where({ id: customerId }).del().catch(() => {});
  });

  afterAll(async () => {
    if (database) await database.destroy();
    await require('../models/db').destroy();
  });

  test('waits on the first canonical sibling before locking the target row', async () => {
    const blocker = await database.transaction();
    let waiterFinished = false;
    try {
      await blocker('invoices').where({ id: invoiceIds[0] }).forUpdate().first('id');

      const waiter = database.transaction(async (trx) => {
        const locked = await InvoiceService.lockInvoicePaymentIntentAllocation(trx, {
          id: invoiceIds[1],
          piId,
          customerId,
          targetForUpdate: true,
        });
        waiterFinished = true;
        return locked;
      });
      await sleep(200);
      expect(waiterFinished).toBe(false);

      // The allocation query is blocked on the lower-id sibling and has not
      // skipped ahead to lock the target. That is the property that prevents
      // target-vs-anchor AB/BA deadlocks during sibling-stamp cleanup.
      await database.transaction(async (probe) => {
        await probe.raw("SET LOCAL lock_timeout = '250ms'");
        await expect(probe('invoices').where({ id: invoiceIds[1] }).forUpdate().first('id'))
          .resolves.toMatchObject({ id: invoiceIds[1] });
      });

      await blocker.commit();
      await expect(waiter).resolves.toMatchObject({ id: invoiceIds[1] });
    } finally {
      await blocker.rollback().catch(() => {});
    }
  });

  test('a page void that waited and finds changed status rejects without canceling or clearing the PI', async () => {
    const targetId = invoiceIds[1];
    const blocker = await database.transaction();
    const retrieve = jest.spyOn(StripeService, 'retrievePaymentIntent');
    const cancel = jest.spyOn(StripeService, 'cancelPaymentIntent');
    try {
      await blocker('invoices').where({ id: targetId }).forUpdate().first('id');

      // The outer snapshot sees `sent`; the transaction then waits for this
      // row lock. Commit a status-only change while retaining the exact PI.
      const voidPromise = InvoiceService.voidInvoice(targetId);
      await sleep(200);
      await blocker('invoices').where({ id: targetId }).update({ status: 'viewed' });
      await blocker.commit();

      await expect(voidPromise).rejects.toThrow(/status changed while voiding/i);
      expect(retrieve).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      await expect(database('invoices').where({ id: targetId }).first('status', 'stripe_payment_intent_id'))
        .resolves.toMatchObject({ status: 'viewed', stripe_payment_intent_id: piId });
      await expect(database('invoices').where({ id: invoiceIds[0] }).first('stripe_payment_intent_id'))
        .resolves.toMatchObject({ stripe_payment_intent_id: piId });
    } finally {
      retrieve.mockRestore();
      cancel.mockRestore();
      await blocker.rollback().catch(() => {});
    }
  });
});
