// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// Plan choice on the invoice pay page (GATE_PAY_PLAN_CHOICE, owner 2026-11-19):
// a customer who accepted an estimate as pay-per-application reads the first
// invoice (setup fee + first application) on its pay link and may prepay the
// year instead. The owner's three rulings are what these tests hold:
//   - the visit that invoice bills counts as visit 1 of the prepaid year,
//     even when it is already completed;
//   - the first invoice stays payable after the choice, and is closed only
//     when the prepay is paid;
//   - paying the first invoice instead leaves the customer on per application.
// The year's price and its refusals are the Schedule switch's own
// (schedule-prepay-switch.test.js covers them); here the real switch, term
// and payment follow-through run end to end.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
process.env.GATE_PAY_PLAN_CHOICE = 'true';
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  Object.defineProperty(db, 'client', { get: () => db.connection.client });
  return db;
});
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: false, blocked: true, code: 'test' })),
}));
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => {}),
  retrievePaymentIntent: jest.fn(async () => ({ status: 'requires_payment_method' })),
  cancelPaymentIntent: jest.fn(async () => null),
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ suppressed: true })) }));
jest.mock('../services/push-notifications', () => ({ sendToAdminUsers: jest.fn(async () => ({ sent: 0 })) }));
jest.mock('../services/account-membership-email', () => ({ sendMembershipStarted: jest.fn(async () => {}), sendMembershipRenewalReminder: jest.fn(async () => {}) }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(), loadTemplateByKey: jest.fn(async () => null), activeSuppressionFor: jest.fn(async () => null),
}));

const { randomUUID } = require('node:crypto');

jest.setTimeout(120000);

const PER_VISIT = 128;
const SETUP_FEE = 99;
const YEAR = PER_VISIT * 4;

postgres('plan choice on the first invoice of an accepted per-application plan', () => {
  let database;
  let trx;
  let PayPlanChoice;
  let AnnualPrepayRenewals;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    require('../models/db').connection = database;
    // Cold transforms of the switch's module graph stay outside a test's timer.
    require('../routes/admin-schedule');
    PayPlanChoice = require('../services/pay-plan-choice');
    AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    trx = await database.transaction();
    require('../models/db').connection = trx;
    AnnualPrepayRenewals._private.resetCachesForTests();
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  const { etDateString, addETDays } = require('../utils/datetime-et');
  const day = (offset) => etDateString(addETDays(new Date(), offset));

  // What the estimate converter leaves behind for a per-application accept of
  // quarterly pest control: the year's four visits and one invoice billing the
  // setup fee and the first application, attached to the first visit.
  async function acceptedPlan({ firstVisitStatus = 'completed', firstVisitDay = -10 } = {}) {
    const f = {
      customerId: randomUUID(), estimateId: randomUUID(), visitId: randomUUID(), invoiceId: randomUUID(),
      laterVisitIds: [randomUUID(), randomUUID(), randomUUID()],
    };
    await trx('customers').insert({ id: f.customerId, first_name: 'Synthetic', last_name: 'Plan', phone: '+12025550123',
      email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false, billing_mode: 'per_application' });
    await trx('estimates').insert({ id: f.estimateId, customer_id: f.customerId, status: 'accepted', accepted_at: new Date() });
    const visit = { customer_id: f.customerId, service_type: 'Quarterly Pest Control', window_start: '09:00', window_end: '10:00',
      estimated_price: PER_VISIT, is_recurring: true, recurring_pattern: 'quarterly', recurring_ongoing: true,
      source_estimate_id: f.estimateId };
    await trx('scheduled_services').insert({ ...visit, id: f.visitId, scheduled_date: day(firstVisitDay), status: firstVisitStatus });
    for (const [i, id] of f.laterVisitIds.entries()) {
      await trx('scheduled_services').insert({ ...visit, id, scheduled_date: day(firstVisitDay + 91 * (i + 1)), status: 'confirmed',
        recurring_parent_id: f.visitId });
    }
    const lines = [
      { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: SETUP_FEE, amount: SETUP_FEE },
      { description: 'First service application', quantity: 1, unit_price: PER_VISIT, amount: PER_VISIT },
    ];
    await trx('invoices').insert({ id: f.invoiceId, customer_id: f.customerId, scheduled_service_id: f.visitId,
      invoice_number: `TEST-${f.invoiceId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), status: 'viewed', sent_at: new Date(),
      total: SETUP_FEE + PER_VISIT, subtotal: SETUP_FEE + PER_VISIT, service_date: day(firstVisitDay), line_items: JSON.stringify(lines),
      notes: `Auto-generated from accepted estimate #${f.estimateId}. Customer selected pay per application.`,
      created_at: new Date(Date.now() - 86400000) });
    return f;
  }

  const firstInvoice = (f) => trx('invoices').where({ id: f.invoiceId }).first();
  const prepayInvoices = (f) => trx('invoices').where({ customer_id: f.customerId }).whereNot({ id: f.invoiceId });
  const termOf = (f) => trx('annual_prepay_terms').where({ customer_id: f.customerId }).first();
  const visit = (id) => trx('scheduled_services').where({ id }).first();
  async function payPrepay(prepayId) {
    const [paid] = await trx('invoices').where({ id: prepayId })
      .update({ status: 'paid', paid_at: new Date(), amount_paid: YEAR }).returning('*');
    await AnnualPrepayRenewals.syncTermForInvoicePayment(paid);
  }

  test('the page offers both plans at the switch’s own price, and the choice mints one unpaid prepay while the first invoice stays payable', async () => {
    const f = await acceptedPlan();
    expect(await PayPlanChoice.planChoiceForInvoice(await firstInvoice(f))).toEqual({
      selected: false,
      serviceType: 'Quarterly Pest Control',
      visitsPerYear: 4,
      perApplication: { perVisit: PER_VISIT, setupFee: SETUP_FEE, yearTotal: YEAR + SETUP_FEE },
      prepay: { total: YEAR, setupFeeWaived: SETUP_FEE, discount: 0, discountLabel: '', savings: SETUP_FEE },
    });

    const first = await PayPlanChoice.selectAnnualPrepay(await firstInvoice(f));
    // A repeat (a double tap, a reload) answers with the same link.
    const again = await PayPlanChoice.selectAnnualPrepay(await firstInvoice(f));
    expect(again).toEqual(first);
    const prepays = await prepayInvoices(f);
    expect(prepays).toHaveLength(1);
    expect(first.payUrl).toContain(`/pay/${prepays[0].token}`);
    expect(prepays[0]).toMatchObject({ status: 'draft', sent_at: null });
    expect(Number(prepays[0].total)).toBe(YEAR);

    // The year starts on the completed visit's own date and nothing covers
    // anything until it is paid.
    const term = await termOf(f);
    expect(term).toMatchObject({ status: 'payment_pending', source_estimate_id: f.estimateId, prepay_invoice_id: prepays[0].id, coverage_visit_count: 4 });
    expect(AnnualPrepayRenewals._private.dateOnly(term.term_start)).toBe(day(-10));
    expect(await firstInvoice(f)).toMatchObject({ status: 'viewed' });
    expect((await visit(f.laterVisitIds[0])).prepaid_method).toBeNull();
    // The page now shows the pick, with no second offer and no token.
    expect(await PayPlanChoice.planChoiceForInvoice(await firstInvoice(f))).toEqual({ selected: true, prepay: { total: YEAR } });
    expect(require('../services/messaging/send-customer-message').sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('paying the prepay closes the first invoice, logs the completed visit as visit 1 and covers the other three', async () => {
    const f = await acceptedPlan();
    await PayPlanChoice.selectAnnualPrepay(await firstInvoice(f));
    const [prepay] = await prepayInvoices(f);
    await payPrepay(prepay.id);

    expect(await termOf(f)).toMatchObject({ status: 'active' });
    const closed = await firstInvoice(f);
    expect(closed.status).toBe('void');
    // The pointer a refund of the prepay restores this invoice by.
    expect(closed.notes).toContain(`[prepay-switch-superseded-by:${prepay.id}]`);
    const done = await visit(f.visitId);
    expect(done).toMatchObject({ status: 'completed', prepaid_method: 'annual_prepay_invoice', annual_prepay_term_id: (await termOf(f)).id });
    expect(Number(done.prepaid_amount)).toBe(PER_VISIT);
    expect(done.prepaid_note).toContain('(1 of 4)');
    for (const id of f.laterVisitIds) {
      expect(Number((await visit(id)).prepaid_amount)).toBe(PER_VISIT);
    }
    // Four visits covered, none seeded beside the booked series.
    expect(await trx('scheduled_services').where({ customer_id: f.customerId })).toHaveLength(4);
    expect((await trx('customers').where({ id: f.customerId }).first()).billing_mode).toBe('annual_prepay');
    // A second sync (the daily sweep, a webhook replay) changes nothing.
    await AnnualPrepayRenewals.syncTermForInvoicePayment(await trx('invoices').where({ id: prepay.id }).first());
    expect(await trx('invoices').where({ customer_id: f.customerId })).toHaveLength(2);
  });

  test('a refund of the paid prepay puts the first invoice back on the books', async () => {
    const f = await acceptedPlan();
    await PayPlanChoice.selectAnnualPrepay(await firstInvoice(f));
    const [prepay] = await prepayInvoices(f);
    await payPrepay(prepay.id);
    const [refunded] = await trx('invoices').where({ id: prepay.id }).update({ status: 'refunded' }).returning('*');
    await AnnualPrepayRenewals.syncTermForInvoicePayment(refunded);
    expect(await termOf(f)).toMatchObject({ status: 'cancelled' });
    const restored = await trx('invoices').where({ customer_id: f.customerId })
      .where('notes', 'like', `%[prepay-switch-restore:${f.invoiceId}]%`);
    expect(restored).toHaveLength(1);
    expect(Number(restored[0].total)).toBe(SETUP_FEE + PER_VISIT);
    expect((await trx('customers').where({ id: f.customerId }).first()).billing_mode).toBe('per_application');
  });

  test('a prepay cancelled while its first invoice is closing leaves that invoice restored, not lost', async () => {
    const f = await acceptedPlan();
    await PayPlanChoice.selectAnnualPrepay(await firstInvoice(f));
    const [prepay] = await prepayInvoices(f);
    // The race: the refund's cancel commits just as the close's void lands,
    // after its own restore looked for (and did not find) a voided invoice.
    const InvoiceService = require('../services/invoice');
    const realVoid = InvoiceService.voidInvoice.bind(InvoiceService);
    const spy = jest.spyOn(InvoiceService, 'voidInvoice').mockImplementation(async (id, opts) => {
      const out = await realVoid(id, opts);
      if (id === f.invoiceId) {
        await trx('invoices').where({ id: prepay.id }).update({ status: 'refunded' });
        await trx('annual_prepay_terms').where({ prepay_invoice_id: prepay.id }).update({ status: 'cancelled' });
      }
      return out;
    });
    try {
      await payPrepay(prepay.id);
    } finally {
      spy.mockRestore();
    }
    expect((await firstInvoice(f)).status).toBe('void');
    const restored = await trx('invoices').where({ customer_id: f.customerId })
      .where('notes', 'like', `%[prepay-switch-restore:${f.invoiceId}]%`);
    expect(restored).toHaveLength(1);
    expect(Number(restored[0].total)).toBe(SETUP_FEE + PER_VISIT);
    // Not logged as covered: the year it would belong to is gone.
    expect((await visit(f.visitId)).prepaid_method).toBeNull();
  });

  test('a first visit still on the schedule is covered like the rest once the prepay is paid', async () => {
    const f = await acceptedPlan({ firstVisitStatus: 'confirmed', firstVisitDay: 5 });
    await PayPlanChoice.selectAnnualPrepay(await firstInvoice(f));
    const [prepay] = await prepayInvoices(f);
    await payPrepay(prepay.id);
    expect((await firstInvoice(f)).status).toBe('void');
    expect(Number((await visit(f.visitId)).prepaid_amount)).toBe(PER_VISIT);
    expect(await trx('scheduled_services').where({ customer_id: f.customerId })).toHaveLength(4);
  });

  test('paying the first invoice after picking the year keeps per application: the unpaid prepay is voided and the choice is gone', async () => {
    const f = await acceptedPlan();
    await PayPlanChoice.selectAnnualPrepay(await firstInvoice(f));
    const [paid] = await trx('invoices').where({ id: f.invoiceId }).update({ status: 'paid', paid_at: new Date() }).returning('*');
    await AnnualPrepayRenewals.syncTermForInvoicePayment(paid);
    // The prepay's pay link can no longer collect a year on top of the
    // invoice just paid, and its pending term is gone with it.
    const [prepay] = await prepayInvoices(f);
    expect(prepay.status).toBe('void');
    expect(await termOf(f)).toMatchObject({ status: 'cancelled' });
    expect(await PayPlanChoice.planChoiceForInvoice(await firstInvoice(f))).toBeNull();
    expect(await PayPlanChoice.selectAnnualPrepay(await firstInvoice(f))).toEqual({ refused: true });
    expect(await prepayInvoices(f)).toHaveLength(1);
    expect((await visit(f.laterVisitIds[0])).prepaid_method).toBeNull();
    expect((await trx('customers').where({ id: f.customerId }).first()).billing_mode).toBe('per_application');
  });

  test('a close that stopped after the void finishes the visit stamp on the next sync', async () => {
    const f = await acceptedPlan();
    await PayPlanChoice.selectAnnualPrepay(await firstInvoice(f));
    const [prepay] = await prepayInvoices(f);
    await payPrepay(prepay.id);
    // The state a crash between the void and the stamp leaves behind.
    await trx('scheduled_services').where({ id: f.visitId })
      .update({ prepaid_amount: null, prepaid_method: null, prepaid_note: null, prepaid_at: null });
    await AnnualPrepayRenewals.syncTermForInvoicePayment(await trx('invoices').where({ id: prepay.id }).first());
    expect(await visit(f.visitId)).toMatchObject({ status: 'completed', prepaid_method: 'annual_prepay_invoice' });
    expect(await trx('activity_log').where({ customer_id: f.customerId, action: 'invoice_replaced_by_annual_prepay' })).toHaveLength(1);
  });

  test('a first invoice with money on it is left for the office when the prepay is paid', async () => {
    const f = await acceptedPlan();
    await PayPlanChoice.selectAnnualPrepay(await firstInvoice(f));
    const [prepay] = await prepayInvoices(f);
    // A part payment lands on the first invoice after the choice.
    await trx('invoices').where({ id: f.invoiceId }).update({ amount_paid: 50 });
    await payPrepay(prepay.id);
    const open = await firstInvoice(f);
    expect(open.status).toBe('viewed');
    expect(open.notes).not.toContain('prepay-switch-superseded-by');
    expect((await visit(f.visitId)).prepaid_method).toBeNull();
  });

  test('the prepay\'s own pay page never adds the first invoice as a previous balance: they are alternatives', async () => {
    const f = await acceptedPlan();
    await PayPlanChoice.selectAnnualPrepay(await firstInvoice(f));
    const [prepay] = await prepayInvoices(f);
    const gates = require('../config/feature-gates').gates;
    const before = gates.payIncludeBalance;
    gates.payIncludeBalance = true;
    try {
      const { combinedEligibleSiblings } = require('../services/pay-combined');
      // Control: an unrelated anchor for this customer does pick the first invoice up.
      const other = { ...prepay, id: randomUUID(), notes: null };
      expect((await combinedEligibleSiblings(other, { readOnly: true }) || []).map((inv) => inv.id)).toEqual([f.invoiceId]);
      expect(await combinedEligibleSiblings(prepay, { readOnly: true })).toBeNull();
    } finally {
      gates.payIncludeBalance = before;
    }
  });

  test('money recorded on the first invoice outside its pay page withholds the choice', async () => {
    const f = await acceptedPlan();
    await trx('invoices').where({ id: f.invoiceId }).update({ payment_recorded_at: new Date(), total: 177 });
    expect(await PayPlanChoice.planChoiceForInvoice(await firstInvoice(f))).toBeNull();
    expect(await PayPlanChoice.selectAnnualPrepay(await firstInvoice(f))).toEqual({ refused: true });
    expect(await prepayInvoices(f)).toHaveLength(0);
  });

  test('with the gate off the page carries no choice and the pick is refused', async () => {
    const f = await acceptedPlan();
    const gates = require('../config/feature-gates').gates;
    gates.payPlanChoice = false;
    try {
      expect(await PayPlanChoice.planChoiceForInvoice(await firstInvoice(f))).toBeNull();
      expect(await PayPlanChoice.selectAnnualPrepay(await firstInvoice(f))).toEqual({ refused: true });
      expect(await prepayInvoices(f)).toHaveLength(0);
    } finally {
      gates.payPlanChoice = true;
    }
  });
});
