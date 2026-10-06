/**
 * Postgres twin of payment-failed-alert-close.test.js: real rows, real SQL.
 * Skips without DATABASE_URL (the CI `server` job runs it migrated).
 */
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: true })) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

postgres('payment_failed bells close when their invoice is paid', () => {
  let db; let PaymentPlans; let Dispatch; let triggerNotification; let customerId; let invoiceA; let invoiceB; const notificationIds = []; const logPis = [];

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local/CI database');
    db = require('../models/db');
    PaymentPlans = require('../services/payment-plans');
    Dispatch = require('../services/payment-failure-notifications');
    ({ triggerNotification } = require('../services/notification-triggers'));
  });
  afterAll(async () => { await db.destroy(); });

  async function insertInvoice(status) {
    const id = randomUUID();
    await db('invoices').insert({
      id, customer_id: customerId, invoice_number: `TST-${id.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''),
      status, total: 120.39, subtotal: 120.39, paid_at: status === 'paid' ? new Date() : null,
      line_items: JSON.stringify([{ description: 'Pest Control', amount: 120.39, quantity: 1, unit_price: 120.39 }]),
    });
    return id;
  }
  async function insertAlert({ paymentIntentId, invoiceId = null, triggerKey = 'payment_failed', category = 'payment' }) {
    const [row] = await db('notifications').insert({
      recipient_type: 'admin', category, title: 'Billing', body: 'payment failed',
      metadata: JSON.stringify({ triggerKey, dedupeKey: `payment-failed:${paymentIntentId}:ch_x`, payload: { invoiceId, paymentIntentId } }),
    }).returning('id');
    const id = row.id ?? row;
    notificationIds.push(id);
    return id;
  }
  const state = (id) => db('notifications').where({ id }).first('done_at', 'done_by', 'resolution');

  beforeEach(async () => {
    customerId = randomUUID();
    await db('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Fixture', email: `${customerId}@example.invalid`,
      phone: '+19415550143', address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer',
    });
    invoiceA = await insertInvoice('overdue');
    invoiceB = await insertInvoice('overdue');
  });
  afterEach(async () => {
    await db('notifications').whereIn('id', notificationIds.splice(0)).del();
    await db('stripe_payment_notification_log').whereIn('payment_intent_id', logPis.splice(0)).del();
    triggerNotification.mockClear();
    await db('payments').where({ customer_id: customerId }).del();
    await db('invoices').where({ customer_id: customerId }).del();
    await db('customers').where({ id: customerId }).del();
  });

  async function failedLedgerRow(invoiceId, piId) {
    await db('payments').insert({
      customer_id: customerId, processor: 'stripe', stripe_payment_intent_id: piId, amount: 120.39, status: 'failed',
      payment_date: '2026-10-05', metadata: JSON.stringify({ invoice_id: invoiceId }),
    });
  }
  async function pay(invoiceId) {
    await db('invoices').where({ id: invoiceId }).update({ status: 'paid', paid_at: new Date() });
    return PaymentPlans.completeActivePlansForInvoice(invoiceId);
  }

  test('matches by the failed attempt ledger row (old alert, no invoiceId stamp)', async () => {
    const piId = `pi_${randomUUID()}`;
    await failedLedgerRow(invoiceA, piId);
    const alert = await insertAlert({ paymentIntentId: piId });
    await pay(invoiceA);
    expect(await state(alert)).toMatchObject({ done_by: 'payments', resolution: 'The invoice was paid' });
    expect((await state(alert)).done_at).not.toBeNull();
  });

  test('matches by the invoiceId stamped on a new alert', async () => {
    const alert = await insertAlert({ paymentIntentId: `pi_${randomUUID()}`, invoiceId: invoiceA });
    await pay(invoiceA);
    expect(await state(alert)).toMatchObject({ done_by: 'payments' });
  });

  test('leaves alerts about another invoice, other triggers and other categories open', async () => {
    const otherPi = `pi_${randomUUID()}`;
    await failedLedgerRow(invoiceB, otherPi);
    const forB = await insertAlert({ paymentIntentId: otherPi });
    const stampedB = await insertAlert({ paymentIntentId: `pi_${randomUUID()}`, invoiceId: invoiceB });
    const wrongTrigger = await insertAlert({ paymentIntentId: otherPi, invoiceId: invoiceA, triggerKey: 'payment_received' });
    const wrongCategory = await insertAlert({ paymentIntentId: otherPi, invoiceId: invoiceA, category: 'ops' });
    await pay(invoiceA);
    for (const id of [forB, stampedB, wrongTrigger, wrongCategory]) {
      expect((await state(id)).done_at).toBeNull();
    }
  });

  test('does not close while the invoice is not paid', async () => {
    const alert = await insertAlert({ paymentIntentId: `pi_${randomUUID()}`, invoiceId: invoiceA });
    await PaymentPlans.completeActivePlansForInvoice(invoiceA);
    expect((await state(alert)).done_at).toBeNull();
  });

  test('keeps a first done_at and resolution a person already wrote; an already system-closed row is untouched', async () => {
    const mine = await insertAlert({ paymentIntentId: `pi_${randomUUID()}`, invoiceId: invoiceA });
    const first = new Date('2026-10-05T14:00:00Z');
    await db('notifications').where({ id: mine }).update({ done_at: first, done_by: randomUUID(), resolution: 'Called the customer' });
    const system = await insertAlert({ paymentIntentId: `pi_${randomUUID()}`, invoiceId: invoiceA });
    await db('notifications').where({ id: system }).update({ done_at: first, done_by: 'relevance', resolution: 'Moved on' });
    await pay(invoiceA);
    const after = await db('notifications').where({ id: mine }).first('done_at', 'done_by', 'resolution');
    expect(after.done_at.toISOString()).toBe(first.toISOString());
    expect(after.resolution).toBe('Called the customer');
    expect(after.done_by).toBe('payments');
    expect(await state(system)).toMatchObject({ done_by: 'relevance', resolution: 'Moved on' });
  });

  test('a combined attempt stays open after one invoice is paid and closes after both', async () => {
    const piId = `pi_${randomUUID()}`;
    await failedLedgerRow(invoiceA, piId);
    await failedLedgerRow(invoiceB, piId);
    const alert = await insertAlert({ paymentIntentId: piId, invoiceId: invoiceA });
    await pay(invoiceA);
    expect((await state(alert)).done_at).toBeNull();
    await pay(invoiceB);
    expect(await state(alert)).toMatchObject({ done_by: 'payments', resolution: 'The invoice was paid' });
  });

  test('a legacy non-UUID invoice id on the failed ledger row never throws and is ignored', async () => {
    const piId = `pi_${randomUUID()}`;
    await failedLedgerRow('legacy-123', piId);
    const alert = await insertAlert({ paymentIntentId: piId, invoiceId: invoiceA });
    await expect(pay(invoiceA)).resolves.toBeDefined();
    expect(await state(alert)).toMatchObject({ done_by: 'payments' });
  });

  async function queueFailureJob(piId) {
    logPis.push(piId);
    await db('stripe_payment_notification_log').insert({
      payment_intent_id: piId, outcome: 'failed', attempt_id: 'ch_x',
      pending_payload: JSON.stringify({ amount: 120.39, customerId, reason: 'Card declined' }),
    });
  }

  test('dispatch with a legacy non-UUID ledger id still raises the alert, with a null invoiceId', async () => {
    const piId = `pi_${randomUUID()}`;
    await failedLedgerRow('legacy-123', piId);
    await queueFailureJob(piId);
    await Dispatch.processPendingPaymentFailureNotifications({ limit: 50 });
    const call = triggerNotification.mock.calls.find(([, payload]) => payload.paymentIntentId === piId);
    expect(call[1]).toMatchObject({ invoiceId: null });
  });

  test('dispatch after the whole allocation was paid through another PaymentIntent raises nothing', async () => {
    const piId = `pi_${randomUUID()}`;
    await failedLedgerRow(invoiceA, piId);
    await queueFailureJob(piId);
    await db('invoices').where({ id: invoiceA }).update({ status: 'paid', paid_at: new Date() });
    await Dispatch.processPendingPaymentFailureNotifications({ limit: 50 });
    expect(triggerNotification.mock.calls.some(([, payload]) => payload.paymentIntentId === piId)).toBe(false);
    const job = await db('stripe_payment_notification_log').where({ payment_intent_id: piId }).first('pending_payload');
    expect(job.pending_payload).toBeNull();
  });
});
