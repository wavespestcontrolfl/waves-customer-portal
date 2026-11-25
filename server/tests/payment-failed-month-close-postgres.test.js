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

    test('processing AND prepaid dues invoices for the same month: the settled one counts, whatever the row order', async () => {
      const bell = await failedBell();
      await insertDuesInvoice('processing');
      await insertDuesInvoice('prepaid');
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

    test('legacy rows without a billed_month stamp never settle: an unstamped failed row, or an unstamped collecting payment', async () => {
      // unstamped failed row (the monthly description and date would have named November)
      const unstampedFailed = await failedBell({ metadata: null });
      await insertPayment({ status: 'paid', date: '2026-11-03', description: MONTHLY, metadata: null });
      await insertPayment(paidNov());
      // stamped failed row, but the only collections are matched by description alone
      await db('payments').where({ customer_id: customerId, status: 'paid' }).del();
      const stampedFailed = await failedBell();
      await insertPayment({ status: 'paid', date: '2026-11-03', description: MONTHLY, metadata: null });
      await insertPayment({ status: 'paid', date: '2026-11-03', description: MONTHLY, metadata: { type: 'monthly_autopay' } });
      // an explicit one-time Charge now carries no billed_month
      await insertPayment({ status: 'paid', date: '2026-11-04', description: 'Manual charge — WaveGuard Gold', metadata: null });
      await sweep();
      expect(await isOpen(unstampedFailed)).toBe(true);
      expect(await isOpen(stampedFailed)).toBe(true);
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

  describe('the sweep holds the Undo locks across its check and its close', () => {
    test('while an Undo-like transaction holds the paid dues invoice, the sweep waits and sees the reverted invoice', async () => {
      const bell = await failedBell();
      const invoice = await insertDuesInvoice('paid');
      const undoLike = await db.transaction();
      await undoLike('invoices').where({ id: invoice }).forUpdate().first('id');
      await undoLike('invoices').where({ id: invoice }).update({ status: 'overdue', paid_at: null });
      let finished = false;
      const running = sweep().then(() => { finished = true; });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(finished).toBe(false);
      expect(await isOpen(bell)).toBe(true);
      await undoLike.commit();
      await running;
      expect(await isOpen(bell)).toBe(true);
    });

    test('when the sweep gets the locks first, a waiting Undo reopens the bell it closed', async () => {
      const bell = await failedBell();
      const invoice = await insertDuesInvoice('paid');
      await sweep();
      expect((await state(bell)).done_by).toBe('payments');
      await db('invoices').where({ id: invoice }).update({ status: 'overdue', paid_at: null });
      await db.transaction((trx) => require('../services/invoice-manual-payment-undo').reopenPaymentFailedBells(trx, invoice, new Date(Date.now() - 60000)));
      expect(await isOpen(bell)).toBe(true);
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

  describe('Undo reopens month-closed bells without judging anything', () => {
    const undo = (invoiceId, since = new Date(Date.now() - 60000)) => {
      const { reopenPaymentFailedBells } = require('../services/invoice-manual-payment-undo');
      return db.transaction((trx) => reopenPaymentFailedBells(trx, invoiceId, since));
    };
    const meta = async (id) => (await db('notifications').where({ id }).first('metadata')).metadata;

    test('the close marks the bell with closedBy and its month', async () => {
      const bell = await failedBell();
      await insertPayment(paidNov());
      await sweep();
      expect(await meta(bell)).toMatchObject({ closedBy: 'month-settled', closedMonth: '2026-11' });
    });

    test('a bell closed by a paid dues invoice reopens when that invoice is unpaid again, and the sweep leaves it open', async () => {
      const bell = await failedBell();
      const invoice = await insertDuesInvoice('paid');
      await PaymentPlans.completeActivePlansForInvoice(invoice);
      expect((await state(bell)).done_by).toBe('payments');
      await db('invoices').where({ id: invoice }).update({ status: 'overdue', paid_at: null });
      await undo(invoice);
      expect(await isOpen(bell)).toBe(true);
      expect(await meta(bell)).not.toHaveProperty('closedBy');
      await sweep();
      expect(await isOpen(bell)).toBe(true);
    });

    test('Undo reopens even when the month is still collected another way; the sweep then closes it again', async () => {
      const bell = await failedBell();
      const invoice = await insertDuesInvoice('paid');
      await insertPayment(paidNov());
      await PaymentPlans.completeActivePlansForInvoice(invoice);
      await sweep();
      expect((await state(bell)).done_by).toBe('payments');
      await db('invoices').where({ id: invoice }).update({ status: 'overdue', paid_at: null });
      await undo(invoice);
      expect(await isOpen(bell)).toBe(true);
      await sweep();
      expect((await state(bell)).done_by).toBe('payments');
    });

    test('a bell closed BEFORE the undone payment was recorded reopens too (A closed, then B recorded, then B undone)', async () => {
      const bellA = await failedBell();
      await insertPayment(paidNov());
      await sweep();
      expect((await state(bellA)).done_by).toBe('payments');
      const invoice = await insertDuesInvoice('overdue');
      const recordedAfter = new Date(Date.now() + 3600000);
      await undo(invoice, recordedAfter);
      expect(await isOpen(bellA)).toBe(true);
    });

    test('a DB error in any settlement read cannot stop the reopen: Undo reads no settlement', async () => {
      const bell = await failedBell();
      await insertPayment(paidNov());
      await sweep();
      expect((await state(bell)).done_by).toBe('payments');
      const invoice = await insertDuesInvoice('overdue');
      const settled = require('../services/payment-failed-month-settled');
      const boom = () => { throw new Error('settlement read down'); };
      const spies = ['isMonthCollected', 'invoicelessAttempt', 'isInvoicelessMonthSettled', 'closeIfMonthCollected']
        .map((name) => jest.spyOn(settled, name).mockImplementation(boom));
      try {
        await expect(undo(invoice)).resolves.toBeDefined();
      } finally { spies.forEach((spy) => spy.mockRestore()); }
      expect(await isOpen(bell)).toBe(true);
    });

    test('only the undone invoice\'s dues month, the same customer, and system month-closes are reopened', async () => {
      const closeFor = async (customer, month) => {
        const piId = `pi_${randomUUID()}`;
        await insertPayment({ customer, piId, status: 'failed', date: `${month}-01`, description: MONTHLY, metadata: { billed_month: month } });
        const bell = await insertBell({ customerId: customer }, piId);
        await insertPayment({ customer, status: 'paid', date: `${month}-03`, description: MONTHLY, metadata: { billed_month: month } });
        return bell;
      };
      const october = await closeFor(customerId, '2026-10');
      const november = await closeFor(customerId, '2026-11');
      const theirs = await closeFor(otherCustomerId, '2026-11');
      const personClosed = await closeFor(customerId, '2026-11');
      await sweep();
      await db('notifications').where({ id: personClosed }).update({ done_by: randomUUID(), resolution: 'Called the customer' });
      for (const id of [october, november, theirs]) expect((await state(id)).done_by).toBe('payments');
      const stamped = await insertDuesInvoice('overdue', '2026-11');
      await undo(stamped);
      expect(await isOpen(november)).toBe(true);
      expect((await state(october)).done_by).toBe('payments');
      expect((await state(theirs)).done_by).toBe('payments');
      expect((await state(personClosed)).resolution).toBe('Called the customer');
      // an invoice with no dues stamp reopens every month-closed bell of that customer
      const plain = await insertPlainInvoice('overdue');
      await undo(plain);
      expect(await isOpen(october)).toBe(true);
      expect((await state(theirs)).done_by).toBe('payments');
      expect((await state(personClosed)).resolution).toBe('Called the customer');
    });
  });

  describe('dispatch of the failure alert', () => {
    let Dispatch; let triggerNotification;
    beforeAll(() => {
      Dispatch = require('../services/payment-failure-notifications');
      ({ triggerNotification } = require('../services/notification-triggers'));
    });
    const jobs = [];
    afterEach(async () => {
      await db('stripe_payment_notification_log').whereIn('payment_intent_id', jobs.splice(0)).del();
      triggerNotification.mockReset();
      triggerNotification.mockImplementation(async () => ({ bellWritten: true }));
    });
    async function queueJob(piId) {
      jobs.push(piId);
      await db('stripe_payment_notification_log').insert({
        payment_intent_id: piId, outcome: 'failed', attempt_id: 'ch_x',
        pending_payload: JSON.stringify({ amount: 113.6, customerId, reason: 'Card declined' }),
      });
    }
    const rang = (piId) => triggerNotification.mock.calls.some(([, payload]) => payload.paymentIntentId === piId);

    test('a month already collected before dispatch raises nothing and clears the job', async () => {
      const piId = `pi_${randomUUID()}`;
      await insertPayment({ piId, ...failedNov() });
      await insertPayment(paidNov());
      await queueJob(piId);
      await Dispatch.processPendingPaymentFailureNotifications({ limit: 50 });
      expect(rang(piId)).toBe(false);
      expect((await db('stripe_payment_notification_log').where({ payment_intent_id: piId }).first('pending_payload')).pending_payload).toBeNull();
    });

    test('an uncollected month, or only another month collected, still rings', async () => {
      const piId = `pi_${randomUUID()}`;
      await insertPayment({ piId, ...failedNov() });
      await insertPayment({ status: 'paid', date: '2026-12-03', description: MONTHLY, metadata: { billed_month: '2026-12' } });
      await queueJob(piId);
      await Dispatch.processPendingPaymentFailureNotifications({ limit: 50 });
      expect(rang(piId)).toBe(true);
    });

    test('the pre-push recheck stops the push when the month is collected during the fan-out', async () => {
      const piId = `pi_${randomUUID()}`;
      await insertPayment({ piId, ...failedNov() });
      await queueJob(piId);
      let continued;
      triggerNotification.mockImplementation(async (_key, _payload, opts) => {
        await insertPayment(paidNov());
        continued = await opts.beforePush();
        return continued ? { bellWritten: true } : { suppressed: true };
      });
      await Dispatch.processPendingPaymentFailureNotifications({ limit: 50 });
      expect(continued).toBe(false);
    });
  });
});
