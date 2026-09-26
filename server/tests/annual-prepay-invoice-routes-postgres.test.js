// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// The Invoices annual-prepay routes that cancel or demote a term must hand the
// customer back to a billable mode: "Remove annual prepay flag" runs the whole
// canonical cancel on an unpaid prepay and refuses one it would double-bill
// (ADMIN-BUG-R16), and "Reverse prepaid" restores the prior billing mode with
// its demotion (ADMIN-BUG-R17). Before, both left the customer on
// billing_mode 'annual_prepay', which the monthly cron skips and unpriced
// completions never invoice.
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
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
// Fire-and-forget side effects of apply-credit that would outlive the
// rolled-back test transaction.
jest.mock('../services/project-report-hold', () => ({ scheduleHoldReleaseSweep: jest.fn() }));
jest.mock('../services/review-request', () => ({ enrollForPaidInvoice: jest.fn(async () => null) }));
jest.mock('../services/stripe', () => ({
  ...jest.requireActual('../services/stripe'),
  retrievePaymentIntent: jest.fn(),
  cancelPaymentIntent: jest.fn(async () => ({ status: 'canceled' })),
}));
jest.mock('../services/invoice-followups', () => ({
  stopOnPayment: jest.fn(async () => null),
  resumeSequence: jest.fn(async () => null),
  resumeSequenceIfSystemResumable: jest.fn(async () => null),
  scheduleForInvoice: jest.fn(async () => null),
}));

const { randomUUID } = require('node:crypto');
const express = require('express');

jest.setTimeout(120000);

postgres('Invoices annual-prepay routes against migrated PostgreSQL', () => {
  let database;
  let trx;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
    // Cold transforms of the route's module graph stay outside a test's timer.
    require('../routes/admin-invoices');
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    trx = await database.transaction();
    require('../models/db').connection = trx;
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function request(method, path, body) {
    const app = express();
    app.use(express.json());
    app.use('/admin/invoices', require('../routes/admin-invoices'));
    app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/invoices${path}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  async function customer(fields = {}) {
    const id = randomUUID();
    await trx('customers').insert({
      id, first_name: 'Synthetic', last_name: 'Prepay', email: `${id}@example.invalid`,
      phone: `fixture-${id.slice(0, 8)}`, ...fields,
    });
    return id;
  }

  async function invoice(customerId, fields = {}) {
    const id = randomUUID();
    await trx('invoices').insert({
      id, customer_id: customerId, token: randomUUID(), invoice_number: `TEST-${id.slice(0, 8)}`,
      subtotal: 400, total: 400, line_items: '[]', ...fields,
    });
    return id;
  }

  const { etDateString } = require('../utils/datetime-et');

  async function markedPaidPrepay() {
    const customerId = await customer({ billing_mode: null });
    const prepayInvoiceId = await invoice(customerId, { status: 'paid', paid_at: new Date() });
    const term = await require('../services/annual-prepay-renewals').createTermForAnnualPrepay({
      customerId, prepayInvoiceId, prepayAmount: 400, termStart: etDateString(), termEnd: null,
      coverageServiceType: 'Quarterly Pest Control', coverageVisitCount: 4,
    });
    return { customerId, prepayInvoiceId, term };
  }

  test('removing the flag from a paid prepay is refused and changes nothing', async () => {
    const { customerId, prepayInvoiceId, term } = await markedPaidPrepay();
    expect(term.status).toBe('active');

    const res = await request('DELETE', `/${prepayInvoiceId}/annual-prepay`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/refund/);
    expect((await trx('annual_prepay_terms').where({ id: term.id }).first('status')).status).toBe('active');
    expect((await trx('invoices').where({ id: prepayInvoiceId }).first('annual_prepay_term_id')).annual_prepay_term_id).toBe(term.id);
    expect((await trx('customers').where({ id: customerId }).first('billing_mode')).billing_mode).toBe('annual_prepay');
  });

  test('removing the flag is refused when the invoice is paid but its term never activated', async () => {
    const customerId = await customer({ billing_mode: null });
    const termId = randomUUID();
    await trx('annual_prepay_terms').insert({
      id: termId, customer_id: customerId, status: 'payment_pending', term_start: etDateString(), term_end: '2099-12-31', prepay_amount: 400,
    });
    // The webhook committed the payment; the term activation after it failed.
    const prepayInvoiceId = await invoice(customerId, { status: 'paid', paid_at: new Date(), annual_prepay_term_id: termId });
    await trx('annual_prepay_terms').where({ id: termId }).update({ prepay_invoice_id: prepayInvoiceId });

    const res = await request('DELETE', `/${prepayInvoiceId}/annual-prepay`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/refund/);
    expect((await trx('annual_prepay_terms').where({ id: termId }).first('status')).status).toBe('payment_pending');
    expect((await trx('invoices').where({ id: prepayInvoiceId }).first('annual_prepay_term_id')).annual_prepay_term_id).toBe(termId);
  });

  test('removing the flag is refused while a payment on the open pay-page session is in flight', async () => {
    const customerId = await customer({ billing_mode: null });
    const termId = randomUUID();
    await trx('annual_prepay_terms').insert({
      id: termId, customer_id: customerId, status: 'payment_pending', term_start: etDateString(), term_end: '2099-12-31', prepay_amount: 400,
    });
    const prepayInvoiceId = await invoice(customerId, { status: 'sent', annual_prepay_term_id: termId, stripe_payment_intent_id: 'pi_synthetic_inflight' });
    await trx('annual_prepay_terms').where({ id: termId }).update({ prepay_invoice_id: prepayInvoiceId });
    require('../services/stripe').retrievePaymentIntent.mockResolvedValueOnce({ id: 'pi_synthetic_inflight', status: 'processing' });

    const res = await request('DELETE', `/${prepayInvoiceId}/annual-prepay`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/in flight/);
    expect(require('../services/stripe').cancelPaymentIntent).not.toHaveBeenCalled();
    expect((await trx('annual_prepay_terms').where({ id: termId }).first('status')).status).toBe('payment_pending');
    expect((await trx('invoices').where({ id: prepayInvoiceId }).first('annual_prepay_term_id')).annual_prepay_term_id).toBe(termId);
  });

  test('an abandoned pay-page session is cancelled before the flag is removed', async () => {
    const customerId = await customer({ billing_mode: null });
    const termId = randomUUID();
    await trx('annual_prepay_terms').insert({
      id: termId, customer_id: customerId, status: 'payment_pending', term_start: etDateString(), term_end: '2099-12-31', prepay_amount: 400,
    });
    const prepayInvoiceId = await invoice(customerId, { status: 'sent', annual_prepay_term_id: termId, stripe_payment_intent_id: 'pi_synthetic_open' });
    await trx('annual_prepay_terms').where({ id: termId }).update({ prepay_invoice_id: prepayInvoiceId });
    require('../services/stripe').retrievePaymentIntent.mockResolvedValueOnce({ id: 'pi_synthetic_open', status: 'requires_payment_method' });

    const res = await request('DELETE', `/${prepayInvoiceId}/annual-prepay`);
    expect(res.status).toBe(200);
    expect(require('../services/stripe').cancelPaymentIntent).toHaveBeenCalledWith('pi_synthetic_open', expect.anything());
    expect((await trx('annual_prepay_terms').where({ id: termId }).first('status')).status).toBe('cancelled');
    // The surviving invoice drops the cancelled session, so it stays editable.
    expect((await trx('invoices').where({ id: prepayInvoiceId }).first('stripe_payment_intent_id')).stripe_payment_intent_id).toBeNull();
  });

  test('a refused removal leaves the customer\'s pay-page session alone', async () => {
    const customerId = await customer({ billing_mode: null });
    const termId = randomUUID();
    await trx('annual_prepay_terms').insert({
      id: termId, customer_id: customerId, status: 'payment_pending', term_start: etDateString(), term_end: '2099-12-31', prepay_amount: 400,
    });
    const prepayInvoiceId = await invoice(customerId, { status: 'sent', annual_prepay_term_id: termId, stripe_payment_intent_id: 'pi_synthetic_kept' });
    await trx('annual_prepay_terms').where({ id: termId }).update({ prepay_invoice_id: prepayInvoiceId });
    await trx('setup_fee_claims').insert({ invoice_id: prepayInvoiceId, amount: 99 });

    const res = await request('DELETE', `/${prepayInvoiceId}/annual-prepay`);
    expect(res.status).toBe(409);
    expect(require('../services/stripe').retrievePaymentIntent).not.toHaveBeenCalled();
    expect(require('../services/stripe').cancelPaymentIntent).not.toHaveBeenCalled();
    expect((await trx('invoices').where({ id: prepayInvoiceId }).first('stripe_payment_intent_id')).stripe_payment_intent_id).toBe('pi_synthetic_kept');
  });

  test('removing the flag from an unpaid prepay runs the canonical cancel: prior billing mode back, covered invoice owed again, open visits released', async () => {
    const { customerId, prepayInvoiceId, term } = await markedPaidPrepay();
    const coveredVisits = await trx('scheduled_services').where({ annual_prepay_term_id: term.id }).orderBy('scheduled_date');
    expect(coveredVisits.length).toBeGreaterThan(1);
    const [doneVisit, ...openVisits] = coveredVisits;
    await trx('scheduled_services').where({ id: doneVisit.id }).update({ status: 'completed' });
    const coveredInvoiceId = await invoice(customerId, {
      status: 'prepaid', paid_at: new Date(), prepaid_prev_status: 'sent', prepaid_at: new Date(),
      annual_prepay_covered_term_id: term.id, scheduled_service_id: doneVisit.id,
    });
    // The prepay went unpaid again (a reverse-prepaid from before this fix,
    // which left billing_mode stranded on 'annual_prepay').
    await trx('invoices').where({ id: prepayInvoiceId }).update({ status: 'sent', paid_at: null });
    await trx('annual_prepay_terms').where({ id: term.id }).update({ status: 'payment_pending' });

    const res = await request('DELETE', `/${prepayInvoiceId}/annual-prepay`);
    expect(res.status).toBe(200);

    expect((await trx('annual_prepay_terms').where({ id: term.id }).first('status')).status).toBe('cancelled');
    expect((await trx('invoices').where({ id: prepayInvoiceId }).first('annual_prepay_term_id')).annual_prepay_term_id).toBeNull();
    // Prior mode 'none' (legacy NULL) is restored, so the cron and completions bill again.
    expect((await trx('customers').where({ id: customerId }).first('billing_mode')).billing_mode).toBeNull();
    const reopened = await trx('invoices').where({ id: coveredInvoiceId }).first('status', 'annual_prepay_covered_term_id');
    expect(reopened).toEqual({ status: 'sent', annual_prepay_covered_term_id: null });
    // Its reminders, stopped at settlement, are re-armed after commit.
    const FollowUps = require('../services/invoice-followups');
    expect(FollowUps.resumeSequenceIfSystemResumable).toHaveBeenCalledWith(coveredInvoiceId);
    expect(FollowUps.scheduleForInvoice).toHaveBeenCalledWith(coveredInvoiceId);
    const released = await trx('scheduled_services').whereIn('id', openVisits.map((v) => v.id))
      .select('annual_prepay_term_id', 'prepaid_method');
    expect(released.every((v) => v.annual_prepay_term_id === null && v.prepaid_method === null)).toBe(true);
    // A completed visit's billing history is not rewritten.
    expect((await trx('scheduled_services').where({ id: doneVisit.id }).first('annual_prepay_term_id')).annual_prepay_term_id).toBe(term.id);
  });

  test('removing the flag from a prepay that carries a setup fee is refused (void restores it instead)', async () => {
    const customerId = await customer({ billing_mode: null });
    const termId = randomUUID();
    await trx('annual_prepay_terms').insert({
      id: termId, customer_id: customerId, status: 'payment_pending', term_start: etDateString(), term_end: '2099-12-31', prepay_amount: 400,
    });
    const prepayInvoiceId = await invoice(customerId, { status: 'sent', annual_prepay_term_id: termId });
    await trx('annual_prepay_terms').where({ id: termId }).update({ prepay_invoice_id: prepayInvoiceId });
    await trx('setup_fee_claims').insert({ invoice_id: prepayInvoiceId, amount: 99 });

    const res = await request('DELETE', `/${prepayInvoiceId}/annual-prepay`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Void/);
    expect((await trx('annual_prepay_terms').where({ id: termId }).first('status')).status).toBe('payment_pending');
    expect((await trx('invoices').where({ id: prepayInvoiceId }).first('annual_prepay_term_id')).annual_prepay_term_id).toBe(termId);
  });

  test('removing the flag from a prepay born from an accepted estimate is refused (void ends it)', async () => {
    const customerId = await customer({ billing_mode: null });
    const estimateId = randomUUID();
    await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted', estimate_data: {} });
    const termId = randomUUID();
    await trx('annual_prepay_terms').insert({
      id: termId, customer_id: customerId, source_estimate_id: estimateId, status: 'payment_pending',
      term_start: etDateString(), term_end: '2099-12-31', prepay_amount: 400,
    });
    const prepayInvoiceId = await invoice(customerId, { status: 'sent', annual_prepay_term_id: termId });
    await trx('annual_prepay_terms').where({ id: termId }).update({ prepay_invoice_id: prepayInvoiceId });

    const res = await request('DELETE', `/${prepayInvoiceId}/annual-prepay`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/accepted estimate/);
    expect((await trx('annual_prepay_terms').where({ id: termId }).first('status')).status).toBe('payment_pending');
    expect((await trx('invoices').where({ id: prepayInvoiceId }).first('annual_prepay_term_id')).annual_prepay_term_id).toBe(termId);
  });

  test('removing the flag refuses a decided term and changes nothing', async () => {
    const customerId = await customer({ billing_mode: 'annual_prepay' });
    const prepayInvoiceId = await invoice(customerId, { status: 'paid', paid_at: new Date() });
    const termId = randomUUID();
    await trx('annual_prepay_terms').insert({
      id: termId, customer_id: customerId, prepay_invoice_id: prepayInvoiceId, status: 'renewed',
      renewal_decision: 'renew', renewal_decision_at: new Date(), term_start: etDateString(), term_end: '2099-12-31',
      prepay_amount: 400, prior_billing_mode: 'none',
    });
    await trx('invoices').where({ id: prepayInvoiceId }).update({ annual_prepay_term_id: termId });

    const res = await request('DELETE', `/${prepayInvoiceId}/annual-prepay`);
    expect(res.status).toBe(409);
    expect(await trx('annual_prepay_terms').where({ id: termId }).first('status', 'renewal_decision'))
      .toEqual({ status: 'renewed', renewal_decision: 'renew' });
    expect((await trx('invoices').where({ id: prepayInvoiceId }).first('annual_prepay_term_id')).annual_prepay_term_id).toBe(termId);
    expect((await trx('customers').where({ id: customerId }).first('billing_mode')).billing_mode).toBe('annual_prepay');
  });

  test('reversing an applied credit restores the recorded prior billing mode with the demotion', async () => {
    const customerId = await customer({ billing_mode: 'per_application', account_credits: 400 });
    const termId = randomUUID();
    await trx('annual_prepay_terms').insert({
      id: termId, customer_id: customerId, status: 'payment_pending',
      term_start: etDateString(), term_end: '2099-12-31', prepay_amount: 400,
    });
    const invoiceId = await invoice(customerId, { status: 'sent', annual_prepay_term_id: termId });
    await trx('annual_prepay_terms').where({ id: termId }).update({ prepay_invoice_id: invoiceId });

    const applied = await request('POST', `/${invoiceId}/apply-credit`, { note: 'synthetic' });
    expect(applied.status).toBe(200);
    expect((await trx('annual_prepay_terms').where({ id: termId }).first('status')).status).toBe('active');
    expect((await trx('customers').where({ id: customerId }).first('billing_mode')).billing_mode).toBe('annual_prepay');

    const reversed = await request('POST', `/${invoiceId}/reverse-prepaid`, { note: 'synthetic' });
    expect(reversed.status).toBe(200);
    expect((await trx('annual_prepay_terms').where({ id: termId }).first('status')).status).toBe('payment_pending');
    expect((await trx('invoices').where({ id: invoiceId }).first('status')).status).toBe('sent');
    const after = await trx('customers').where({ id: customerId }).first('billing_mode', 'account_credits');
    expect(after.billing_mode).toBe('per_application');
    expect(Number(after.account_credits)).toBe(400);
  });
});
