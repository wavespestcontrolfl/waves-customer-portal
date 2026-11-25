/**
 * A payment_failed bell with NO invoice (a declined monthly-dues autopay charge)
 * closes itself once that SAME billed month's dues are collected, and never on
 * customer + amount alone. Real rows, real SQL; skips without DATABASE_URL (the
 * CI `server` job runs it migrated). Rule: services/payment-failed-month-settled.js.
 */
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: true })) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

postgres('invoice-less payment_failed bells close by billed month', () => {
  let db; let PaymentPlans; let Close; let customerId; let otherCustomerId; const notificationIds = [];

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local/CI database');
    db = require('../models/db');
    PaymentPlans = require('../services/payment-plans');
    Close = require('../services/payment-failed-alert-close');
  });
  afterAll(async () => { await db.destroy(); });

  async function insertCustomer() {
    const id = randomUUID();
    await db('customers').insert({
      id, first_name: 'Synthetic', last_name: 'Fixture', email: `${id}@example.invalid`,
      phone: '+19415550143', address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer',
    });
    return id;
  }
  async function insertPayment({ customer = customerId, piId = null, status, date, description, metadata }) {
    const [row] = await db('payments').insert({
      customer_id: customer, processor: piId ? 'stripe' : null, stripe_payment_intent_id: piId, amount: 113.6, status,
      payment_date: date, description, metadata: metadata === undefined ? null : JSON.stringify(metadata),
    }).returning('id');
    return row.id ?? row;
  }
  const MONTHLY = 'Gold WaveGuard Monthly — Synthetic Fixture';
  const failedNov = (extra = {}) => ({ status: 'failed', date: '2026-11-01', description: MONTHLY, metadata: { type: 'monthly_autopay', billed_month: '2026-11' }, ...extra });
  const paidNov = (extra = {}) => ({ status: 'paid', date: '2026-11-03', description: MONTHLY, metadata: { type: 'monthly_autopay', billed_month: '2026-11' }, ...extra });

  async function insertDuesInvoice(status, month = '2026-11', customer = customerId) {
    const id = randomUUID();
    await db('invoices').insert({
      id, customer_id: customer, invoice_number: `TST-${id.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''),
      status, total: 113.6, subtotal: 113.6, paid_at: status === 'paid' ? new Date() : null,
      line_items: JSON.stringify([{ description: 'WaveGuard dues', amount: 113.6, quantity: 1, unit_price: 113.6, membership_dues_month: month }]),
    });
    return id;
  }
  async function insertPlainInvoice(status) {
    const id = randomUUID();
    await db('invoices').insert({
      id, customer_id: customerId, invoice_number: `TST-${id.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''),
      status, total: 113.6, subtotal: 113.6, paid_at: status === 'paid' ? new Date() : null,
      line_items: JSON.stringify([{ description: 'Pest Control', amount: 113.6, quantity: 1, unit_price: 113.6 }]),
    });
    return id;
  }
  async function insertBell(payloadOverrides = {}, piId = `pi_${randomUUID()}`) {
    const payload = { invoiceId: null, customerId, paymentIntentId: piId, attemptId: 'ch_x', ...payloadOverrides };
    const [row] = await db('notifications').insert({
      recipient_type: 'admin', category: 'payment', title: 'Billing', body: 'payment failed',
      metadata: JSON.stringify({ triggerKey: 'payment_failed', dedupeKey: `payment-failed:${piId}:ch_x`, payload }),
    }).returning('id');
    const id = row.id ?? row;
    notificationIds.push(id);
    return id;
  }
  // A bell plus its failed ledger row (the usual shape).
  async function failedBell(rowOverrides = {}, payloadOverrides = {}) {
    const piId = `pi_${randomUUID()}`;
    await insertPayment({ piId, ...failedNov(rowOverrides) });
    return insertBell(payloadOverrides, piId);
  }
  const state = (id) => db('notifications').where({ id }).first('done_at', 'done_by', 'resolution');
  const sweep = async () => {
    await db('system_settings').where({ key: 'payment_failed_alert_sweep_cursor' }).del();
    return Close.sweepSettledPaymentFailedAlerts({ conn: db });
  };
  const isOpen = async (id) => (await state(id)).done_at === null;

  beforeEach(async () => {
    customerId = await insertCustomer();
    otherCustomerId = await insertCustomer();
  });
  afterEach(async () => {
    await db('notifications').whereIn('id', notificationIds.splice(0)).del();
    await db('payments').whereIn('customer_id', [customerId, otherCustomerId]).del();
    await db('invoices').whereIn('customer_id', [customerId, otherCustomerId]).del();
    await db('customers').whereIn('id', [customerId, otherCustomerId]).del();
  });

  describe('the same month collected closes the bell (sweep)', () => {
    test('a paid payment stamped with the same billed month', async () => {
      const bell = await failedBell();
      await insertPayment(paidNov());
      expect(await sweep()).toBeGreaterThanOrEqual(1);
      expect(await state(bell)).toMatchObject({ done_by: 'payments', resolution: 'The invoice was paid' });
    });

    test('"Charge now": the failed row has the manual-charge description but a billed_month stamp', async () => {
      const bell = await failedBell({ description: 'Manual charge — WaveGuard Gold' });
      await insertPayment(paidNov());
      await sweep();
      expect((await state(bell)).done_by).toBe('payments');
    });

    test('Charge now for an EARLIER month: the stamp, not the payment date, names the month', async () => {
      const bell = await failedBell({ date: '2026-11-20', metadata: { billed_month: '2026-10' }, description: 'Manual charge — WaveGuard Gold' });
      // November collected: not October.
      await insertPayment(paidNov());
      await sweep();
      expect(await isOpen(bell)).toBe(true);
      await insertPayment({ status: 'paid', date: '2026-11-21', description: 'Manual charge — WaveGuard Gold', metadata: { billed_month: '2026-10' } });
      await sweep();
      expect((await state(bell)).done_by).toBe('payments');
    });

    test('an unstamped legacy failed row: the monthly description and the payment month', async () => {
      const bell = await failedBell({ metadata: null });
      await insertPayment({ status: 'paid', date: '2026-11-03', description: MONTHLY, metadata: null });
      await sweep();
      expect((await state(bell)).done_by).toBe('payments');
    });

    test('a completion-minted dues invoice for that month, paid (and prepaid)', async () => {
      const paid = await failedBell();
      await insertDuesInvoice('paid');
      await sweep();
      expect((await state(paid)).done_by).toBe('payments');
      await db('invoices').where({ customer_id: customerId }).del();
      await db('notifications').where({ id: paid }).update({ done_at: null, done_by: null, resolution: null });
      await insertDuesInvoice('prepaid');
      await sweep();
      expect((await state(paid)).done_by).toBe('payments');
    });
  });

  describe('never a false close', () => {
    test('a December payment does not close November\'s bell, even with the same amount', async () => {
      const bell = await failedBell();
      await insertPayment({ status: 'paid', date: '2026-12-03', description: MONTHLY, metadata: { type: 'monthly_autopay', billed_month: '2026-12' } });
      await insertPayment({ status: 'paid', date: '2026-12-04', description: MONTHLY, metadata: null });
      await sweep();
      expect(await isOpen(bell)).toBe(true);
    });

    test('a payment with the same customer and amount but no monthly marker or stamp does not close it', async () => {
      const bell = await failedBell();
      await insertPayment({ status: 'paid', date: '2026-11-03', description: 'Invoice INV-1 — Pest Control', metadata: null });
      await insertPayment({ status: 'paid', date: '2026-11-03', description: 'One-time service', metadata: { invoice_id: randomUUID() } });
      await sweep();
      expect(await isOpen(bell)).toBe(true);
    });

    test('an unrelated invoice paid for the customer closes nothing (hook and sweep)', async () => {
      const bell = await failedBell();
      const invoice = await insertPlainInvoice('overdue');
      await db('invoices').where({ id: invoice }).update({ status: 'paid', paid_at: new Date() });
      await PaymentPlans.completeActivePlansForInvoice(invoice);
      await sweep();
      expect(await isOpen(bell)).toBe(true);
    });

    test('another customer\'s paid payment, or paid dues invoice, for the month closes nothing', async () => {
      const bell = await failedBell();
      await insertPayment(paidNov({ customer: otherCustomerId }));
      await insertDuesInvoice('paid', '2026-11', otherCustomerId);
      await sweep();
      expect(await isOpen(bell)).toBe(true);
    });

    test('a dues invoice for ANOTHER month, or one still open or processing, does not close it', async () => {
      const bell = await failedBell();
      await insertDuesInvoice('paid', '2026-12');
      await insertDuesInvoice('overdue');
      await insertDuesInvoice('processing');
      await sweep();
      expect(await isOpen(bell)).toBe(true);
    });

    test.each(['failed', 'processing', 'refunded', 'canceled'])('a %s payment for the month is not a collection', async (status) => {
      const bell = await failedBell();
      await insertPayment(paidNov({ status }));
      await sweep();
      expect(await isOpen(bell)).toBe(true);
    });

    test('the failed row itself never settles its own bell', async () => {
      const bell = await failedBell();
      await sweep();
      expect(await isOpen(bell)).toBe(true);
    });

    test('a malformed or impossible billed_month stamp leaves it open', async () => {
      await insertPayment(paidNov());
      for (const billedMonth of ['garbage', '2026-13', '2026-1', 20261, ['2026-11']]) {
        const bell = await failedBell({ metadata: { billed_month: billedMonth } });
        await sweep();
        expect(await isOpen(bell)).toBe(true);
      }
    });

    test('an unstamped row without the monthly description has no month, so it stays open', async () => {
      const bell = await failedBell({ metadata: null, description: 'One-time service' });
      await insertPayment({ status: 'paid', date: '2026-11-03', description: 'One-time service', metadata: null });
      await insertPayment(paidNov());
      await sweep();
      expect(await isOpen(bell)).toBe(true);
    });

    test('no ledger row, no PaymentIntent, a PI of another customer, or two rows on one PI all stay open', async () => {
      await insertPayment(paidNov());
      const noRow = await insertBell({}, `pi_${randomUUID()}`);
      const noPi = await insertBell({ paymentIntentId: null });
      const otherPi = `pi_${randomUUID()}`;
      await insertPayment({ piId: otherPi, customer: otherCustomerId, ...failedNov() });
      const wrongCustomer = await insertBell({}, otherPi);
      const twoRows = `pi_${randomUUID()}`;
      await insertPayment({ piId: twoRows, ...failedNov() });
      await insertPayment({ piId: twoRows, ...failedNov() });
      const ambiguous = await insertBell({}, twoRows);
      await sweep();
      for (const id of [noRow, noPi, wrongCustomer, ambiguous]) expect(await isOpen(id)).toBe(true);
    });

    test('a bell whose payload has a non-UUID customer, an invoice id, or a declared allocation stays open', async () => {
      await insertPayment(paidNov());
      const bells = [];
      for (const overrides of [
        { customerId: 'not-a-uuid' },
        { customerId: null },
        { invoiceId: randomUUID() },
        { invoiceId: 'junk' },
        { allocationInvoiceIds: [randomUUID()] },
        { allocationInvoiceIds: [] , allocationUnreadable: true },
        { allocationInvoiceIds: 'junk' },
      ]) bells.push(await failedBell({}, overrides));
      await sweep();
      for (const id of bells) expect(await isOpen(id)).toBe(true);
    });

    test('a failed row that names an invoice (even a malformed id) is not a dues attempt', async () => {
      await insertPayment(paidNov());
      const named = await failedBell({ metadata: { billed_month: '2026-11', invoice_id: randomUUID() } });
      const legacy = await failedBell({ metadata: { billed_month: '2026-11', invoice_id: 'legacy-123' } });
      await sweep();
      expect(await isOpen(named)).toBe(true);
      expect(await isOpen(legacy)).toBe(true);
    });

    test('a bell of the same shape in another customer is judged by its own month and customer', async () => {
      const mine = await failedBell();
      const piId = `pi_${randomUUID()}`;
      await insertPayment({ piId, customer: otherCustomerId, ...failedNov() });
      const theirs = await insertBell({ customerId: otherCustomerId }, piId);
      await insertPayment(paidNov({ customer: otherCustomerId }));
      await sweep();
      expect(await isOpen(mine)).toBe(true);
      expect((await state(theirs)).done_by).toBe('payments');
    });
  });

  describe('the paid-invoice hook', () => {
    test('a paid dues invoice closes the customer\'s invoice-less bell for that month, not another month\'s', async () => {
      const november = await failedBell();
      const piId = `pi_${randomUUID()}`;
      await insertPayment({ piId, status: 'failed', date: '2026-10-01', description: MONTHLY, metadata: { billed_month: '2026-10' } });
      const october = await insertBell({}, piId);
      const invoice = await insertDuesInvoice('overdue');
      await PaymentPlans.completeActivePlansForInvoice(invoice);
      expect(await isOpen(november)).toBe(true);
      await db('invoices').where({ id: invoice }).update({ status: 'paid', paid_at: new Date() });
      await PaymentPlans.completeActivePlansForInvoice(invoice);
      expect((await state(november)).done_by).toBe('payments');
      expect(await isOpen(october)).toBe(true);
    });

    test('a paid invoice of another customer does not close this customer\'s bell', async () => {
      const bell = await failedBell();
      const invoice = await insertDuesInvoice('paid', '2026-11', otherCustomerId);
      await PaymentPlans.completeActivePlansForInvoice(invoice);
      expect(await isOpen(bell)).toBe(true);
    });
  });

  describe('undoing the collecting payment reopens it', () => {
    const undo = (invoiceId) => {
      const { reopenPaymentFailedBells } = require('../services/invoice-manual-payment-undo');
      return db.transaction((trx) => reopenPaymentFailedBells(trx, invoiceId, new Date(Date.now() - 60000)));
    };

    test('a bell closed by a paid dues invoice reopens when that invoice is unpaid again', async () => {
      const bell = await failedBell();
      const invoice = await insertDuesInvoice('paid');
      await PaymentPlans.completeActivePlansForInvoice(invoice);
      expect((await state(bell)).done_by).toBe('payments');
      await db('invoices').where({ id: invoice }).update({ status: 'overdue', paid_at: null });
      await undo(invoice);
      expect(await isOpen(bell)).toBe(true);
      // and the sweep does not close it again while the month is uncollected
      await sweep();
      expect(await isOpen(bell)).toBe(true);
    });

    test('it stays closed when the month is still collected another way', async () => {
      const bell = await failedBell();
      const invoice = await insertDuesInvoice('paid');
      await insertPayment(paidNov());
      await PaymentPlans.completeActivePlansForInvoice(invoice);
      expect((await state(bell)).done_by).toBe('payments');
      await db('invoices').where({ id: invoice }).update({ status: 'overdue', paid_at: null });
      await undo(invoice);
      expect((await state(bell)).done_by).toBe('payments');
    });

    test('another customer\'s closed bell, and a bell a person closed, are left alone', async () => {
      const piId = `pi_${randomUUID()}`;
      await insertPayment({ piId, customer: otherCustomerId, ...failedNov() });
      const theirs = await insertBell({ customerId: otherCustomerId }, piId);
      await insertPayment(paidNov({ customer: otherCustomerId }));
      const mine = await failedBell();
      await db('notifications').where({ id: mine }).update({ done_at: new Date(), done_by: randomUUID(), resolution: 'Called the customer' });
      await sweep();
      expect((await state(theirs)).done_by).toBe('payments');
      const invoice = await insertDuesInvoice('overdue');
      await undo(invoice);
      expect((await state(theirs)).done_by).toBe('payments');
      expect((await state(mine)).resolution).toBe('Called the customer');
    });
  });
});
