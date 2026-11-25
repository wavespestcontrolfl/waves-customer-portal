// Real PostgreSQL transactions (rolled back): production share refunds, PR 3a (production-share-refunds.js). The code never measures a
// refund: it detects one (signals per source), flags the stop in its own week ($0, the owner sets the credit), lists a new refund on a paid
// stop, and moves the credit the owner says between share weeks. All names are synthetic. DATABASE_URL-gated.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = req.headers['x-test-admin'] || null;
    req.techRole = req.headers['x-test-role'] || 'admin';
    // The login's own email: the owner-account predicate reads it (ib-access.js).
    req.technician = { email: req.headers['x-test-email'] || '' };
    next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const { randomUUID } = require('node:crypto');
const express = require('express');
const router = require('../routes/admin-payroll');
const { addStaffWorkDays } = require('../utils/staff-time-work-date');
const productionSharePay = require('../services/payroll-production-share');
const productionShareRefunds = require('../services/production-share-refunds');
const { REFUND_CREDIT_NOTE_PREFIX, REFUND_CREDIT_NOTE_SUFFIX } = require('../services/customer-credit');
const refundCreditNote = (invoice) => `${REFUND_CREDIT_NOTE_PREFIX}${invoice.invoice_number || invoice.id}${REFUND_CREDIT_NOTE_SUFFIX}`;

jest.setTimeout(60000);

const W1 = '2026-09-14'; // Monday; pay Friday 2026-09-25
const LONG_AGO = '2026-01-05';
const noon = (date) => `${date}T16:00:00Z`;

postgres('production share refunds', () => {
  let database;
  let server;
  let baseUrl;
  let trx;
  let phone = 5550900;
  const OLD = {};
  const GATES = ['GATE_PAYROLL', 'GATE_PAYROLL_PRODUCTION_SHARE', 'GATE_PAYROLL_PAY_LINES', 'GATE_PAYROLL_TIME_OFF'];
  const ADMIN_ID = randomUUID();
  const addDays = (ymd, n) => addStaffWorkDays(ymd, n);

  const tech = async (name, patch = {}) => {
    const id = randomUUID();
    await trx('technicians').insert({
      id, name, employment_type: 'w2', employment_status: 'active', pay_rate: '20.00', hire_date: LONG_AGO, flsa_overtime_covered: true, ...patch,
    });
    await trx('payroll_w4_elections').insert({
      technician_id: id, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    });
    return id;
  };
  const worked = (technicianId, weekStart, regularHours, overtimeHours = 0) => trx('time_weekly_summary').insert({
    technician_id: technicianId, week_start: weekStart, week_end: addDays(weekStart, 6), status: 'approved',
    regular_minutes: (regularHours * 60).toFixed(2), overtime_minutes: (overtimeHours * 60).toFixed(2),
  });
  const customer = async () => {
    const id = randomUUID();
    phone += 1;
    await trx('customers').insert({ id, first_name: 'Sample', phone: `+1941${phone}` });
    return id;
  };
  // One completed route stop priced by the visit ('priced' credit); `price` null = no price on file (needs review).
  const stop = async (technicianId, date, price, sameCustomer = null, patch = {}) => {
    const customerId = sameCustomer || await customer();
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id, customer_id: customerId, technician_id: technicianId, scheduled_date: date, service_type: 'General Pest Control',
      status: 'completed', completed_at: noon(date), estimated_price: price == null ? null : price, ...patch,
    });
    await trx('service_records').insert({
      customer_id: customerId, technician_id: technicianId, service_date: date, service_type: patch.service_type || 'General Pest Control',
      scheduled_service_id: id, status: 'completed', structured_notes: JSON.stringify({ visitOutcome: 'completed' }),
    });
    return id;
  };
  const settings = (technicianId, patch = {}) => trx('production_share_settings').insert({
    technician_id: technicianId, from_week: '2026-01-05', rate_bps: 1500, bar_type: 'per_shift', bar_cents: 90000,
    callback_stop_value_cents: 9500, ...patch,
  });
  const api = async (method, path, { body, raw = false } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-admin': ADMIN_ID, 'x-test-email': 'contact@wavespestcontrol.com' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) return { status: response.status, text: await response.text() };
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  // The conflict state the preview shows for a stop (what the page sends with a credit); '' when it cannot be read.
  const shownBasis = async ({ technicianId, visitId, weekStart }) => {
    try {
      const shown = await api('GET', `/production-share/preview?technicianId=${technicianId}&weekStart=${weekStart}`);
      return (shown.body.stops.find((row) => row.visitId === visitId) || {}).stopRevision || '';
    } catch { return ''; }
  };
  // A page sends the state it saw: the helper reads it from the preview unless the test says what to send.
  const override = async (body) => api('PUT', '/production-share/stop-override', {
    body: { ...body, ...(body.stopRevision === undefined ? { stopRevision: await shownBasis(body) } : {}) },
  });
  const draft = (weekStart) => api('POST', '/runs', { body: { weekStart } });
  const finalize = async (runId, token) => {
    const shown = token ? null : await api('GET', `/runs/${runId}`);
    return api('POST', `/runs/${runId}/finalize`, { body: { token: token || shown.body.run.token } });
  };
  const byName = (run, name) => run.checks.find((c) => c.name === name);

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    const app = express();
    app.use(express.json());
    app.use('/api/admin/payroll', router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/payroll`;
  });
  beforeEach(async () => {
    for (const name of GATES) OLD[name] = process.env[name];
    process.env.GATE_PAYROLL = 'true';
    process.env.GATE_PAYROLL_PRODUCTION_SHARE = 'true';
    delete process.env.GATE_PAYROLL_PAY_LINES;
    delete process.env.GATE_PAYROLL_TIME_OFF;
    trx = await database.transaction();
    mockConnection = trx;
    await trx('technicians').insert({ id: ADMIN_ID, name: 'Sample Admin', role: 'admin', employment_type: '1099', employment_status: 'active' });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await trx.rollback();
    for (const name of GATES) { if (OLD[name] === undefined) delete process.env[name]; else process.env[name] = OLD[name]; }
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  // ---- helpers of this suite
  const W2 = addDays(W1, 7);
  const W3 = addDays(W2, 7);
  // An invoice linked to a visit; a payment on the same card charge with a refund.
  const invoiceFor = async (customerId, total, patch = {}) => (await trx('invoices').insert({
    token: randomUUID().slice(0, 32), invoice_number: `S-${randomUUID().slice(0, 8)}`, customer_id: customerId, status: 'paid',
    subtotal: total, discount_amount: '0.00', tax_amount: '0.00', total, ...patch,
  }).returning('id'))[0].id;
  const paymentOf = async (customerId, patch = {}) => (await trx('payments').insert({
    customer_id: customerId, payment_date: '2026-09-15', amount: '500.00', status: 'paid', ...patch,
  }).returning('id'))[0].id;
  const signals = async (visitIds) => productionShareRefunds.refundSignalsOf(trx, visitIds);
  const preview = async (technicianId, weekStart) => (await api('GET', `/production-share/preview?technicianId=${technicianId}&weekStart=${weekStart}`)).body;
  const rowOf = (shown, visitId) => shown.stops.find((one) => one.visitId === visitId);
  // The revision of the stored answer, as the page would have it from the preview ('none' when there is no answer).
  const revisionNow = async (checkId, visitId) => {
    const row = await trx('production_share_refund_take_backs').where({ source_check_id: checkId, visit_id: visitId })
      .first('id', trx.raw(`to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS updated_text`));
    return row ? `${Number(row.id)}:${row.updated_text}` : 'none';
  };
  // A page sends the answer it saw: the helper reads it from the table unless the test says what to send.
  const takeBack = async (body) => api('PUT', '/production-share/refund-take-back', {
    body: { ...body, answerRevision: body.answerRevision === undefined ? await revisionNow(body.checkId, body.visitId) : body.answerRevision },
  });
  const bells = () => trx('notifications').whereRaw("metadata->>'dedupeKey' LIKE 'production-share-refund:%'").count({ n: '*' }).first().then((row) => Number(row.n));

  // One $1,000.00 stop in W1 on its own paid invoice (card charge pi_<tag>), paid by a final pay run; W2 and W3 have ordinary stops.
  // Returns the ids. Bar $100 for each shift, 15%: week 1 share $135.00.
  const paidWorld = async (tag = 'a') => {
    const id = await tech('Sample Alpha');
    await settings(id, { bar_cents: 10000 });
    for (const week of [W1, W2, W3]) await worked(id, week, 40);
    const customerId = await customer();
    const visit = await stop(id, W1, '1000.00', customerId);
    const invoiceId = await invoiceFor(customerId, '1000.00', { scheduled_service_id: visit, stripe_payment_intent_id: `pi_${tag}`, stripe_charge_id: `ch_${tag}` });
    const run1 = (await draft(W1)).body.run;
    const done1 = (await finalize(run1.id)).body.run;
    const checkId = byName(done1, 'Sample Alpha').id;
    return { id, customerId, visit, invoiceId, run1: done1, checkId, tag };
  };
  const refundOn = (world, amount, patch = {}) => paymentOf(world.customerId, { stripe_payment_intent_id: `pi_${world.tag}`, stripe_charge_id: `ch_${world.tag}`, refund_amount: amount, ...patch });
  const week = async (world, weekStart, price) => {
    await stop(world.id, weekStart, price, world.customerId);
    return preview(world.id, weekStart);
  };
  const finalWeek = async (weekStart) => {
    const run = (await draft(weekStart)).body.run;
    return { run, done: (await finalize(run.id)).body.run };
  };

  describe('what counts as a refund signal', () => {
    it('matches a refund by the invoice id in the payment, or by the payment intent, or by the charge id, each alone', async () => {
      const id = await tech('Sample Alpha');
      const customerId = await customer();
      const byMeta = await stop(id, W1, '100.00', customerId);
      const byIntent = await stop(id, W1, '100.00', customerId);
      const byCharge = await stop(id, W1, '100.00', customerId);
      const clean = await stop(id, W1, '100.00', customerId);
      const metaInvoice = await invoiceFor(customerId, '100.00', { scheduled_service_id: byMeta });
      await invoiceFor(customerId, '100.00', { scheduled_service_id: byIntent, stripe_payment_intent_id: 'pi_i' });
      await invoiceFor(customerId, '100.00', { scheduled_service_id: byCharge, stripe_charge_id: 'ch_c' });
      await invoiceFor(customerId, '100.00', { scheduled_service_id: clean, stripe_payment_intent_id: 'pi_clean' });
      const pMeta = await paymentOf(customerId, { refund_amount: '5.00', metadata: JSON.stringify({ invoice_id: metaInvoice }) });
      const pIntent = await paymentOf(customerId, { refund_amount: '6.50', stripe_payment_intent_id: 'pi_i' });
      const pCharge = await paymentOf(customerId, { refund_amount: '7.00', stripe_charge_id: 'ch_c' });
      await paymentOf(customerId, { refund_amount: '0.00', stripe_payment_intent_id: 'pi_clean' });
      const found = await signals([byMeta, byIntent, byCharge, clean, byMeta]);
      expect(found.get(byMeta)).toEqual([`pay:${pMeta}:500`]);
      expect(found.get(byIntent)).toEqual([`pay:${pIntent}:650`]);
      expect(found.get(byCharge)).toEqual([`pay:${pCharge}:700`]);
      expect(found.get(clean)).toEqual([]);
      expect(found.size).toBe(4);
    });

    it('flags every invoice a combined charge paid, and a second refund on the same payment row is a new signal', async () => {
      const id = await tech('Sample Alpha');
      const customerId = await customer();
      const a = await stop(id, W1, '100.00', customerId);
      const b = await stop(id, W1, '100.00', customerId);
      const invoiceA = await invoiceFor(customerId, '100.00', { scheduled_service_id: a });
      const invoiceB = await invoiceFor(customerId, '100.00', { scheduled_service_id: b });
      // One card charge paid both invoices: a payment row for each, the refund is recorded on one of them.
      const rowA = await paymentOf(customerId, { stripe_payment_intent_id: 'pi_combo', stripe_charge_id: 'ch_combo', metadata: JSON.stringify({ invoice_id: invoiceA }), refund_amount: '10.00' });
      await paymentOf(customerId, { stripe_payment_intent_id: 'pi_combo', stripe_charge_id: 'ch_combo', metadata: JSON.stringify({ invoice_id: invoiceB }) });
      const first = await signals([a, b]);
      expect(first.get(a)).toEqual([`pay:${rowA}:1000`]);
      expect(first.get(b)).toEqual([`pay:${rowA}:1000`]);
      await trx('payments').where({ id: rowA }).update({ refund_amount: '25.00' });
      const second = await signals([a]);
      expect(second.get(a)).toEqual([`pay:${rowA}:2500`]);
      expect(second.get(a)).not.toEqual(first.get(a));
    });

    it('reads a parked refund, returned credit, a refunded invoice and a payer-statement refund', async () => {
      const id = await tech('Sample Alpha');
      const customerId = await customer();
      const parked = await stop(id, W1, '100.00', customerId);
      const credit = await stop(id, W1, '100.00', customerId);
      const refunded = await stop(id, W1, '100.00', customerId);
      const statement = await stop(id, W1, '100.00', customerId);
      const noise = await stop(id, W1, '100.00', customerId);
      await invoiceFor(customerId, '100.00', { scheduled_service_id: parked, stripe_charge_id: 'ch_parked' });
      const creditInvoice = await invoiceFor(customerId, '100.00', { scheduled_service_id: credit });
      const creditInvoiceNumber = (await trx('invoices').where({ id: creditInvoice }).first('invoice_number')).invoice_number;
      const refundedInvoice = await invoiceFor(customerId, '100.00', { scheduled_service_id: refunded, status: 'refunded' });
      const [payer] = await trx('payers').insert({ display_name: 'Sample Payer' }).returning('id');
      const [stmt] = await trx('payer_statements').insert({
        payer_id: payer.id, period_start: '2026-09-01', period_end: '2026-09-30', terms_snapshot: 'due_on_receipt', token: randomUUID(),
      }).returning('id');
      await invoiceFor(customerId, '100.00', { scheduled_service_id: statement, payer_statement_id: stmt.id });
      await invoiceFor(customerId, '100.00', { scheduled_service_id: noise, stripe_charge_id: 'ch_noise' });
      const [orphan] = await trx('stripe_orphan_charges').insert({
        stripe_payment_intent_id: 'pi_combo:partial-refund:re_1', stripe_charge_id: 'ch_parked', amount: '12.00', source: 'combined_pay_webhook',
        original_db_error: 'Partial refund re_1 of $12 on a combined balance charge - attribute and reconcile manually',
      }).returning('id');
      // A parked charge that is not a refund (a captured charge the database failed to record) is not a refund signal.
      await trx('stripe_orphan_charges').insert({
        stripe_payment_intent_id: 'pi_other', stripe_charge_id: 'ch_noise', amount: '12.00', source: 'autopay_charge', original_db_error: 'insert failed',
      });
      const ledger = await trx('customer_credit_ledger').insert({
        customer_id: customerId, delta: '20.00', balance_after: '20.00', source: 'adjustment', invoice_id: creditInvoice,
        note: refundCreditNote({ invoice_number: creditInvoiceNumber, id: creditInvoice }),
      }).returning('id');
      const stmtPayment = await paymentOf(customerId, { statement_id: stmt.id, refund_amount: '8.00', customer_id: null, stripe_payment_intent_id: 'pi_stmt' });
      const found = await signals([parked, credit, refunded, statement, noise]);
      expect(found.get(parked)).toEqual([`orphan:${orphan.id}`]);
      expect(found.get(credit)).toEqual([`credit:${ledger[0].id}`]);
      expect(found.get(refunded)).toEqual([`inv-refunded:${refundedInvoice}`]);
      // The statement payment is also matched by its own payment intent (over-detecting on purpose): both ids name the same refund.
      expect(found.get(statement)).toEqual([`pay:${stmtPayment}:800`, `stmt:${stmtPayment}:800`]);
      expect(found.get(noise)).toEqual([]);
    });

    it('reaches the invoices of the package root for a follow-up, and the prepay invoice of an annual term for a stamped visit', async () => {
      const id = await tech('Sample Alpha');
      const customerId = await customer();
      const root = await stop(id, W1, '300.00', customerId, { service_key_snapshot: 'bed_bug_treatment' });
      const followUp = await stop(id, W2, '0.00', customerId, { followup_included: true, followup_source_service_id: root });
      await invoiceFor(customerId, '300.00', { scheduled_service_id: root, stripe_payment_intent_id: 'pi_root' });
      const paid = await paymentOf(customerId, { stripe_payment_intent_id: 'pi_root', refund_amount: '30.00' });
      const termInvoice = await invoiceFor(customerId, '100.00', { stripe_payment_intent_id: 'pi_term' });
      const termId = randomUUID();
      await trx('annual_prepay_terms').insert({
        id: termId, customer_id: customerId, term_start: '2026-09-01', term_end: '2027-08-31', status: 'active', prepay_amount: '100.00',
        prepay_invoice_id: termInvoice, coverage_visit_count: 2,
      });
      const stamped = await stop(id, W1, '0.00', customerId, { annual_prepay_term_id: termId, prepaid_amount: '50.00', prepaid_method: 'annual_prepay_invoice' });
      const termPayment = await paymentOf(customerId, { stripe_payment_intent_id: 'pi_term', refund_amount: '10.00' });
      const found = await signals([followUp, stamped]);
      expect(found.get(followUp)).toEqual([`pay:${paid}:3000`]);
      expect(found.get(stamped)).toEqual([`pay:${termPayment}:1000`]);
    });
  });

  describe('a refund in the stop\'s own week', () => {
    it('flags the stop: $0, needs review, and says the owner sets its credit; a clean stop is not touched', async () => {
      const id = await tech('Sample Alpha');
      await settings(id);
      const customerId = await customer();
      const refunded = await stop(id, W1, '100.00', customerId);
      const clean = await stop(id, addDays(W1, 1), '100.00', customerId);
      await invoiceFor(customerId, '100.00', { scheduled_service_id: refunded, stripe_payment_intent_id: 'pi_own' });
      await paymentOf(customerId, { stripe_payment_intent_id: 'pi_own', refund_amount: '10.00' });
      const shown = await preview(id, W1);
      expect(rowOf(shown, refunded)).toMatchObject({
        kind: 'refund_flagged', creditCents: 0, needsReview: true, refundSignals: [expect.stringMatching(/^pay:/)],
        reason: 'A refund is recorded on this visit. Set its credit in the production share preview.',
      });
      expect(rowOf(shown, clean)).toMatchObject({ kind: 'priced', creditCents: 10000, needsReview: false });
      expect(shown.creditedCents).toBe(10000);
    });

    it('uses the owner\'s credit while the signals are the ones he saw, and stops using it when a new refund appears', async () => {
      const id = await tech('Sample Alpha');
      await settings(id);
      const customerId = await customer();
      const visit = await stop(id, W1, '100.00', customerId);
      await invoiceFor(customerId, '100.00', { scheduled_service_id: visit, stripe_payment_intent_id: 'pi_own2' });
      await paymentOf(customerId, { stripe_payment_intent_id: 'pi_own2', refund_amount: '10.00' });
      const set = await override({ technicianId: id, visitId: visit, weekStart: W1, creditCents: 9000, reason: 'Refund was $10' });
      expect(set.status).toBe(200);
      expect(rowOf(await preview(id, W1), visit)).toMatchObject({ kind: 'owner_set', creditCents: 9000, needsReview: false });
      // A second refund: the credit he set is no longer used, the stop reports it and he looks again.
      await paymentOf(customerId, { stripe_payment_intent_id: 'pi_own2', refund_amount: '20.00' });
      // The new refund is named as the cause (its own kind, a reason that says refund) and rings the refund bell.
      const after = rowOf(await preview(id, W1), visit);
      expect(after).toMatchObject({ kind: 'owner_override_refund_changed', creditCents: 0, needsReview: true, reason: expect.stringMatching(/new refund/) });
      expect(await bells()).toBe(2);
    });

    it('rings one bell for the flagged stop, however many times a preview reads it, and a new signal rings again', async () => {
      const id = await tech('Sample Alpha');
      await settings(id);
      const customerId = await customer();
      const visit = await stop(id, W1, '100.00', customerId);
      await invoiceFor(customerId, '100.00', { scheduled_service_id: visit, stripe_payment_intent_id: 'pi_bell' });
      await paymentOf(customerId, { stripe_payment_intent_id: 'pi_bell', refund_amount: '10.00' });
      expect(await bells()).toBe(0);
      await preview(id, W1);
      await preview(id, W1);
      expect(await bells()).toBe(1);
      const row = await trx('notifications').whereRaw("metadata->>'dedupeKey' LIKE 'production-share-refund:%'").first();
      // No customer name, no amount, no id in what the owner reads.
      expect(`${row.title} ${row.body}`).not.toMatch(/Sample|\$|[0-9a-f]{8}-/);
      await paymentOf(customerId, { stripe_payment_intent_id: 'pi_bell', refund_amount: '20.00' });
      await preview(id, W1);
      expect(await bells()).toBe(2);
    });
  });

  describe('a refund on a stop a final pay check paid', () => {
    it('freezes no signal for a clean stop, lists a later refund as take-back to set, and a draft names it', async () => {
      const world = await paidWorld('freeze');
      const frozen = await trx('payroll_checks').where({ id: world.checkId }).first('calc_snapshot');
      expect(frozen.calc_snapshot.productionShare.stops[0]).not.toHaveProperty('refundSignals');
      const payment = await refundOn(world, '30.00');
      const shown = await week(world, W2, '500.00');
      expect(shown.takeBackToSet).toEqual([{
        checkId: world.checkId, visitId: world.visit, workDate: W1, paidWeekStart: W1, creditCents: 100000, newSignals: [`pay:${payment}:3000`], answerRevision: 'none',
        reason: 'new', previousCents: null,
        visit: { serviceType: 'General Pest Control', scheduledDate: W1, windowDisplay: null, completedAt: `${W1}T16:00:00.000Z` },
      }]);
      expect(shown.takeBacks).toEqual([]);
      expect(shown.creditedCents).toBe(50000);
      const created = (await draft(W2)).body.run;
      expect(created.productionShareNotes).toEqual([expect.stringMatching(/1 paid stop has a new or changed refund/)]);
      const row = await trx('payroll_checks').where({ id: byName(created, 'Sample Alpha').id }).first('calc_snapshot');
      expect(row.calc_snapshot.productionShare.takeBackToSet).toHaveLength(1);
      expect(await bells()).toBe(1);
    });

    it('freezes the signals of a stop the owner credited by hand, so only a later refund is new', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      for (const weekStart of [W1, W2]) await worked(id, weekStart, 40);
      const customerId = await customer();
      const visit = await stop(id, W1, '100.00', customerId);
      await invoiceFor(customerId, '100.00', { scheduled_service_id: visit, stripe_payment_intent_id: 'pi_hand' });
      const first = await paymentOf(customerId, { stripe_payment_intent_id: 'pi_hand', refund_amount: '10.00' });
      // $200.00 credited above the $100.00 bar: a share of $15.00, so the week counts as paid.
      expect((await override({ technicianId: id, visitId: visit, weekStart: W1, creditCents: 20000, reason: 'Refund was $10' })).status).toBe(200);
      const { done } = await finalWeek(W1);
      const stored = await trx('payroll_checks').where({ id: byName(done, 'Sample Alpha').id }).first('calc_snapshot');
      expect(stored.calc_snapshot.productionShare.stops[0]).toMatchObject({ kind: 'owner_set', creditCents: 20000, refundSignals: [`pay:${first}:1000`] });
      await stop(id, W2, '500.00', customerId);
      expect((await preview(id, W2)).takeBackToSet).toEqual([]);
      const second = await paymentOf(customerId, { stripe_payment_intent_id: 'pi_hand', refund_amount: '15.00' });
      expect((await preview(id, W2)).takeBackToSet).toEqual([expect.objectContaining({ visitId: visit, creditCents: 20000, newSignals: [`pay:${second}:1500`] })]);
    });

    it('takes the owner\'s total back from the next week, capped at that week\'s production, and the rest from the week after', async () => {
      const world = await paidWorld('cap');
      await refundOn(world, '30.00');
      const open = await week(world, W2, '500.00');
      const { newSignals } = open.takeBackToSet[0];
      // The cap is the credit the check paid: $1,000.00.
      const over = await takeBack({ checkId: world.checkId, visitId: world.visit, cents: 100001, signals: newSignals });
      expect(over.status).toBe(400);
      expect(over.body.error).toMatch(/more than the credit/);
      const set = await takeBack({ checkId: world.checkId, visitId: world.visit, cents: 100000, signals: newSignals, note: 'Full refund' });
      expect(set.status).toBe(200);
      // Week 2 has $500.00 of production: it takes $500.00 and $500.00 stays owed. The answer covers the signal: nothing to set.
      const week2 = await preview(world.id, W2);
      expect(week2.takeBackToSet).toEqual([]);
      expect(week2.takeBackAnswers).toEqual([expect.objectContaining({ cents: 100000, note: 'Full refund' })]);
      expect(week2.takeBacks).toEqual([expect.objectContaining({ sourceCheckId: world.checkId, visitId: world.visit, cents: 50000 })]);
      expect(week2).toMatchObject({ creditedCents: 0, refundTakeBackCents: 50000, owedTakeBackCents: 100000, shareCents: 0 });
      const { done } = await finalWeek(W2);
      const check2 = byName(done, 'Sample Alpha');
      expect(check2.productionShare).toMatchObject({ creditedCents: 0, refundTakeBackCents: 50000, takeBackCount: 1 });
      // Hourly pay is untouched by a take-back.
      expect(check2.regularPayCents).toBe(80000);
      // Week 3 takes the rest.
      await stop(world.id, W3, '800.00', world.customerId);
      const week3 = await preview(world.id, W3);
      expect(week3.takeBacks).toEqual([expect.objectContaining({ cents: 50000, dependsOnRuns: [world.run1.id, done.id].sort() })]);
      expect(week3.creditedCents).toBe(30000);
    });

    it('gives credit back when the owner lowers the total, and when he clears the answer', async () => {
      const world = await paidWorld('lower');
      await refundOn(world, '30.00');
      const open = await week(world, W2, '500.00');
      const { newSignals } = open.takeBackToSet[0];
      await takeBack({ checkId: world.checkId, visitId: world.visit, cents: 30000, signals: newSignals });
      const { done } = await finalWeek(W2);
      expect(byName(done, 'Sample Alpha').productionShare.refundTakeBackCents).toBe(30000);
      // Lower it to $100.00: week 3 gives $200.00 back.
      await stop(world.id, W3, '100.00', world.customerId);
      expect((await takeBack({ checkId: world.checkId, visitId: world.visit, cents: 10000, signals: newSignals })).status).toBe(200);
      const lowered = await preview(world.id, W3);
      expect(lowered.takeBacks).toEqual([expect.objectContaining({ cents: -20000 })]);
      expect(lowered).toMatchObject({ refundTakeBackCents: -20000, creditedCents: 30000 });
      // Clear it: everything taken is given back.
      const cleared = await api('DELETE', '/production-share/refund-take-back', {
        body: { checkId: world.checkId, visitId: world.visit, answerRevision: await revisionNow(world.checkId, world.visit) },
      });
      expect(cleared.status).toBe(200);
      expect((await preview(world.id, W3)).takeBacks).toEqual([expect.objectContaining({ cents: -30000 })]);
    });

    it('lists the stop again when a new refund appears after the answer, and the dependency holds a void', async () => {
      const world = await paidWorld('again');
      const first = await refundOn(world, '30.00');
      const open = await week(world, W2, '500.00');
      await takeBack({ checkId: world.checkId, visitId: world.visit, cents: 30000, signals: open.takeBackToSet[0].newSignals });
      const { done } = await finalWeek(W2);
      await stop(world.id, W3, '100.00', world.customerId);
      expect((await preview(world.id, W3)).takeBackToSet).toEqual([]);
      const second = await refundOn(world, '40.00');
      const again = (await preview(world.id, W3)).takeBackToSet;
      expect(again).toEqual([expect.objectContaining({ visitId: world.visit, newSignals: [`pay:${first}:3000`, `pay:${second}:4000`].sort() })]);
      // The first answer is not enough for a stale page: the signals it sends must be the current ones.
      const stale = await takeBack({ checkId: world.checkId, visitId: world.visit, cents: 40000, signals: [`pay:${first}:3000`] });
      expect(stale.status).toBe(409);
      expect((await takeBack({ checkId: world.checkId, visitId: world.visit, cents: 40000, signals: again[0].newSignals })).status).toBe(200);
      // Week 2 took $300.00; a final week 3 takes $100.00 more and relies on both runs: neither can be voided under it.
      const { done: done3 } = await finalWeek(W3);
      expect(byName(done3, 'Sample Alpha').productionShare.refundTakeBackCents).toBe(10000);
      // The checks of week 3 name both runs, so a void of either is held (dependentChecksOf, any technician's later check).
      expect(await productionSharePay.dependentChecksOf(trx, world.run1.id)).toEqual([{ employeeName: 'Sample Alpha', weekStart: W2 }, { employeeName: 'Sample Alpha', weekStart: W3 }]);
      expect(await productionSharePay.dependentChecksOf(trx, done.id)).toEqual([{ employeeName: 'Sample Alpha', weekStart: W3 }]);
      for (const run of [world.run1, done]) {
        const voided = await api('POST', `/runs/${run.id}/void`, { body: { reason: 'test' } });
        expect(voided.status).toBe(409);
      }
    });

    it('keeps a 0-cent entry once a source has history, so the dependency is not lost', async () => {
      const world = await paidWorld('zero');
      await refundOn(world, '30.00');
      const open = await week(world, W2, '500.00');
      await takeBack({ checkId: world.checkId, visitId: world.visit, cents: 30000, signals: open.takeBackToSet[0].newSignals });
      const { done } = await finalWeek(W2);
      await stop(world.id, W3, '100.00', world.customerId);
      const week3 = await preview(world.id, W3);
      expect(week3.takeBacks).toEqual([expect.objectContaining({ cents: 0, dependsOnRuns: [world.run1.id, done.id].sort() })]);
      const { done: done3 } = await finalWeek(W3);
      const stored = await trx('payroll_checks').where({ id: byName(done3, 'Sample Alpha').id }).first('calc_snapshot');
      expect(stored.calc_snapshot.productionShare.takeBacks[0]).toMatchObject({ cents: 0, sourceCheckId: world.checkId });
      expect((await api('POST', `/runs/${done.id}/void`, { body: { reason: 'test' } })).status).toBe(409);
    });

    it('makes a draft stale when an answer or a new refund lands between draft and finalize', async () => {
      const world = await paidWorld('stale');
      await refundOn(world, '30.00');
      await stop(world.id, W2, '500.00', world.customerId);
      const draftRun = (await draft(W2)).body.run;
      const open = await preview(world.id, W2);
      await takeBack({ checkId: world.checkId, visitId: world.visit, cents: 10000, signals: open.takeBackToSet[0].newSignals });
      const shown = (await api('GET', `/runs/${draftRun.id}`)).body.run;
      expect(shown.stale).toBe(true);
      const refused = await finalize(draftRun.id, draftRun.token);
      expect(refused.status).toBe(409);
      // A fresh read is stable again; then a new refund makes it stale once more.
      await api('POST', `/runs/${draftRun.id}/recompute`, { body: {} });
      const fresh = (await api('GET', `/runs/${draftRun.id}`)).body.run;
      expect(fresh.stale).toBe(false);
      await refundOn(world, '5.00');
      expect((await api('GET', `/runs/${draftRun.id}`)).body.run.stale).toBe(true);
    });

    it('revision and signature change with an answer and with a new signal (pure inputs)', async () => {
      const world = await paidWorld('rev');
      await refundOn(world, '30.00');
      await stop(world.id, W2, '500.00', world.customerId);
      // The routes write on the test transaction, so every read here is on it (the pool connection would see none of it).
      const before = productionSharePay.revisionOf(await productionSharePay.readInputsUnderLock(trx, W2));
      const open = await preview(world.id, W2);
      await takeBack({ checkId: world.checkId, visitId: world.visit, cents: 10000, signals: open.takeBackToSet[0].newSignals });
      const inputs = await productionSharePay.readInputsUnderLock(trx, W2);
      const answered = productionSharePay.revisionOf(inputs);
      expect(answered).not.toBe(before);
      await refundOn(world, '9.00');
      const moreRefund = productionSharePay.revisionOf(await productionSharePay.readInputsUnderLock(trx, W2));
      expect(moreRefund).not.toBe(answered);
      const shares = productionSharePay.sharesFor(inputs, [world.id], W2);
      expect(shares.get(world.id).snapshot.takeBacks).toHaveLength(1);
      expect(productionSharePay.signature({ production_share_cents: 0, production_share: shares.get(world.id).snapshot }))
        .not.toEqual(productionSharePay.signature({ production_share_cents: 0, production_share: { ...shares.get(world.id).snapshot, takeBacks: [], refundTakeBackCents: 0 } }));
    });
  });

  describe('what a take-back source is, and what counts as new', () => {
    it('a stop on a check that paid no share is not a source: no prompt, and the route refuses it', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      for (const weekStart of [W1, W2]) await worked(id, weekStart, 40);
      const customerId = await customer();
      // $90.00 credited under the $100.00 bar: a share of $0, the check is final but paid nothing.
      const visit = await stop(id, W1, '90.00', customerId);
      await invoiceFor(customerId, '90.00', { scheduled_service_id: visit, stripe_payment_intent_id: 'pi_zero' });
      const { done } = await finalWeek(W1);
      const check = byName(done, 'Sample Alpha');
      expect(check.productionShareCents).toBe(0);
      await paymentOf(customerId, { stripe_payment_intent_id: 'pi_zero', refund_amount: '10.00' });
      await stop(id, W2, '500.00', customerId);
      const shown = await preview(id, W2);
      expect(shown.takeBackToSet).toEqual([]);
      const refused = await takeBack({ checkId: check.id, visitId: visit, cents: 100, signals: [] });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/paid a share/);
    });

    it('finds a later refund from the invoices the check froze, when the visit link is gone', async () => {
      const world = await paidWorld('frozen');
      const frozen = await trx('payroll_checks').where({ id: world.checkId }).first('calc_snapshot');
      expect(frozen.calc_snapshot.productionShare.stops[0]).toMatchObject({ invoices: [world.invoiceId], refundInvoices: [world.invoiceId] });
      // The invoice is relinked away from the visit: the live links no longer reach it.
      await trx('invoices').where({ id: world.invoiceId }).update({ scheduled_service_id: null });
      expect((await signals([world.visit])).get(world.visit)).toEqual([]);
      const payment = await refundOn(world, '30.00');
      const shown = await week(world, W2, '500.00');
      expect(shown.takeBackToSet).toEqual([expect.objectContaining({ visitId: world.visit, newSignals: [`pay:${payment}:3000`] })]);
      // The save-time check reads the same frozen invoices.
      expect((await takeBack({ checkId: world.checkId, visitId: world.visit, cents: 1000, signals: shown.takeBackToSet[0].newSignals })).status).toBe(200);
    });

    it('freezes the prepay invoice of an annual term with a paid prepaid-plan stop', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      await worked(id, W1, 40);
      const customerId = await customer();
      const termInvoice = await invoiceFor(customerId, '100.00', { stripe_payment_intent_id: 'pi_termfrozen' });
      const termId = randomUUID();
      await trx('annual_prepay_terms').insert({
        id: termId, customer_id: customerId, term_start: '2026-09-01', term_end: '2027-08-31', status: 'active', prepay_amount: '100.00',
        prepay_invoice_id: termInvoice, coverage_visit_count: 1,
      });
      await stop(id, W1, '0.00', customerId, { annual_prepay_term_id: termId, prepaid_amount: '400.00', prepaid_method: 'annual_prepay_invoice' });
      const { done } = await finalWeek(W1);
      const stored = await trx('payroll_checks').where({ id: byName(done, 'Sample Alpha').id }).first('calc_snapshot');
      expect(stored.calc_snapshot.productionShare.stops[0]).toMatchObject({ kind: 'prepaid_plan', creditCents: 40000, refundInvoices: [termInvoice] });
      expect(stored.calc_snapshot.productionShare.stops[0].invoices).toBeUndefined();
    });

    it('a replacement refund of the same amount on the same payment is a new signal, when the Stripe refund ids were recorded', async () => {
      const id = await tech('Sample Alpha');
      const customerId = await customer();
      const visit = await stop(id, W1, '100.00', customerId);
      await invoiceFor(customerId, '100.00', { scheduled_service_id: visit, stripe_payment_intent_id: 'pi_repl' });
      const payment = await paymentOf(customerId, {
        stripe_payment_intent_id: 'pi_repl', refund_amount: '10.00', stripe_refund_id: 're_1', metadata: JSON.stringify({ stamped_refund_ids: ['re_1'] }),
      });
      const first = (await signals([visit])).get(visit);
      expect(first).toEqual([expect.stringMatching(new RegExp(`^pay:${payment}:1000:[0-9a-f]{10}$`))]);
      // re_1 failed and re_2 succeeded for the same $10.00.
      await trx('payments').where({ id: payment }).update({ stripe_refund_id: 're_2', metadata: JSON.stringify({ stamped_refund_ids: ['re_2'] }) });
      const second = (await signals([visit])).get(visit);
      expect(second).toHaveLength(1);
      expect(second[0]).not.toEqual(first[0]);
      // A legacy row (no refund id recorded) keeps the cents-only form.
      await trx('payments').where({ id: payment }).update({ stripe_refund_id: null, metadata: null });
      expect((await signals([visit])).get(visit)).toEqual([`pay:${payment}:1000`]);
    });
  });

  describe('an answer is in force only while the refunds equal the ones he saw', () => {
    // A $300.00 answer taken in week 2, then the refunds change.
    const answered = async (tag) => {
      const world = await paidWorld(tag);
      const first = await refundOn(world, '30.00');
      const open = await week(world, W2, '500.00');
      await takeBack({ checkId: world.checkId, visitId: world.visit, cents: 30000, signals: open.takeBackToSet[0].newSignals });
      const { done } = await finalWeek(W2);
      await stop(world.id, W3, '800.00', world.customerId);
      return { world, first, done };
    };

    it('stores exactly the signals he saw, and a new signal reopens the stop: previous total shown, nothing more moves, a bell rings', async () => {
      const { world, first } = await answered('eq1');
      const stored = await trx('production_share_refund_take_backs').first('signals', 'cents');
      expect(stored.signals).toEqual([`pay:${first}:3000`]);
      expect((await preview(world.id, W3)).takeBacks).toEqual([expect.objectContaining({ cents: 0 })]);
      const before = await bells();
      const second = await refundOn(world, '40.00');
      const shown = await preview(world.id, W3);
      expect(shown.takeBackToSet).toEqual([expect.objectContaining({ visitId: world.visit, reason: 'new', previousCents: 30000, newSignals: [`pay:${first}:3000`, `pay:${second}:4000`].sort() })]);
      expect(shown.takeBackAnswers).toEqual([expect.objectContaining({ cents: 30000, inForce: false })]);
      // Out of force: not even more of the $300.00 is taken; only the 0 entry that keeps its dependency.
      expect(shown.takeBacks.map((one) => [one.cents, one.dependsOnRuns.length])).toEqual([[0, 2]]);
      expect(shown.creditedCents).toBe(80000);
      expect(await bells()).toBe(before + 1);
    });

    it('reopens the stop when a refund he answered is reversed, and a new answer against the refunds now moves the credit again', async () => {
      const { world, first, done } = await answered('eq2');
      expect(byName(done, 'Sample Alpha').productionShare.refundTakeBackCents).toBe(30000);
      const before = await bells();
      // Stripe reversed the refund: the payment row goes back to no refund.
      await trx('payments').where({ id: first }).update({ refund_amount: '0.00' });
      const shown = await preview(world.id, W3);
      expect(shown.takeBackToSet).toEqual([expect.objectContaining({ visitId: world.visit, reason: 'changed', previousCents: 30000, newSignals: [], answerRevision: expect.stringMatching(/^\d+:/) })]);
      expect(shown.takeBackAnswers).toEqual([expect.objectContaining({ cents: 30000, inForce: false })]);
      // Still $300.00 taken, nothing given back and nothing more taken until he answers again.
      expect(shown.takeBacks).toEqual([expect.objectContaining({ cents: 0 })]);
      expect(await bells()).toBe(before + 1);
      // A stale page (still sending the old signal) is refused; the current ones (none) are accepted and give the $300.00 back.
      const stale = await takeBack({ checkId: world.checkId, visitId: world.visit, cents: 0, signals: [`pay:${first}:3000`] });
      expect(stale.status).toBe(409);
      expect((await takeBack({ checkId: world.checkId, visitId: world.visit, cents: 0, signals: [] })).status).toBe(200);
      const after = await preview(world.id, W3);
      expect(after.takeBackToSet).toEqual([]);
      expect(after.takeBacks).toEqual([expect.objectContaining({ cents: -30000 })]);
    });

    it('does not take anything from an answered stop whose refund reversed even when the first answer had been taken in full', async () => {
      const { world, first } = await answered('eq3');
      await trx('payments').where({ id: first }).update({ refund_amount: '0.00' });
      const week3 = await preview(world.id, W3);
      expect(week3.refundTakeBackCents).toBe(0);
      expect(week3.owedTakeBackCents).toBe(0);
    });
  });

  describe('what is a refund is what the commission ledger already says, plus exact writer keys', () => {
    it('flags an estimate deposit applied to the invoice once its refund reached applied money, and not before', async () => {
      const id = await tech('Sample Alpha');
      const customerId = await customer();
      const visit = await stop(id, W1, '100.00', customerId);
      const [estimate] = await trx('estimates').insert({ customer_id: customerId, status: 'accepted', accepted_at: `${W1}T14:00:00Z` }).returning('id');
      const credit = { description: 'Deposit credit (paid at acceptance)', quantity: 1, unit_price: -20, amount: -20, category: 'deposit_credit', estimate_id: estimate.id };
      await invoiceFor(customerId, '80.00', { scheduled_service_id: visit, line_items: JSON.stringify([{ description: 'Service', amount: 100 }, credit]) });
      const [deposit] = await trx('estimate_deposits').insert({
        estimate_id: estimate.id, customer_id: customerId, amount: '20.00', credited_amount: '20.00', status: 'credited', stripe_payment_intent_id: `pi_dep_${randomUUID()}`,
      }).returning('id');
      expect((await signals([visit])).get(visit)).toEqual([]);
      // Refunded in full: no payments row exists, only the deposit ledger says so.
      await trx('estimate_deposits').where({ id: deposit.id }).update({ status: 'refunded', refunded_amount: '20.00' });
      expect((await signals([visit])).get(visit)).toEqual([`deposit:${deposit.id}:2000`]);
      // A refund of a deposit that was never applied does not reach this invoice (the commission rule).
      await trx('estimate_deposits').where({ id: deposit.id }).update({ status: 'refunded', refunded_amount: '5.00', credited_amount: '5.00', amount: '25.00' });
      expect((await signals([visit])).get(visit)).toEqual([]);
      // A voided invoice gave its credit back to the deposit: nothing here either.
      await trx('estimate_deposits').where({ id: deposit.id }).update({ amount: '20.00', credited_amount: '20.00', refunded_amount: '20.00' });
      await trx('invoices').where({ scheduled_service_id: visit }).update({ status: 'void' });
      expect((await signals([visit])).get(visit)).toEqual([]);
    });

    it('flags a refunded or disputed payment with no refund amount, by its state, through the intent, the invoice id and the manual description', async () => {
      const id = await tech('Sample Alpha');
      const customerId = await customer();
      const byIntent = await stop(id, W1, '100.00', customerId);
      const byMeta = await stop(id, W1, '100.00', customerId);
      const byManual = await stop(id, W1, '100.00', customerId);
      await invoiceFor(customerId, '100.00', { scheduled_service_id: byIntent, stripe_payment_intent_id: 'pi_nil', status: 'sent' });
      const metaInvoice = await invoiceFor(customerId, '100.00', { scheduled_service_id: byMeta, status: 'sent' });
      const manualInvoice = await invoiceFor(customerId, '100.00', { scheduled_service_id: byManual, status: 'sent' });
      const manualNumber = (await trx('invoices').where({ id: manualInvoice }).first('invoice_number')).invoice_number;
      const refunded = await paymentOf(customerId, { stripe_payment_intent_id: 'pi_nil', status: 'refunded', refund_amount: null });
      const disputed = await paymentOf(customerId, { metadata: JSON.stringify({ invoice_id: metaInvoice }), status: 'disputed', refund_amount: '0.00' });
      const manual = await paymentOf(customerId, { description: `Invoice ${manualNumber} — Zelle`, status: 'refunded', refund_amount: '0.00' });
      // An ordinary paid row with no refund is not a signal.
      await paymentOf(customerId, { stripe_payment_intent_id: 'pi_nil', status: 'paid', refund_amount: '0.00' });
      const found = await signals([byIntent, byMeta, byManual]);
      expect(found.get(byIntent)).toEqual([`pay:${refunded}:refunded`]);
      expect(found.get(byMeta)).toEqual([`pay:${disputed}:disputed`]);
      expect(found.get(byManual)).toEqual([`pay:${manual}:refunded`]);
    });

    it('does not read a payer transfer, a void or a won dispute as a refund, by exact note and key', async () => {
      const id = await tech('Sample Alpha');
      const customerId = await customer();
      const transfer = await stop(id, W1, '100.00', customerId);
      const voided = await stop(id, W1, '100.00', customerId);
      const won = await stop(id, W1, '100.00', customerId);
      const transferInvoice = await invoiceFor(customerId, '100.00', { scheduled_service_id: transfer });
      const voidedInvoice = await invoiceFor(customerId, '100.00', { scheduled_service_id: voided });
      await invoiceFor(customerId, '100.00', { scheduled_service_id: won, stripe_charge_id: 'ch_won', stripe_payment_intent_id: 'pi_won' });
      const credit = (invoiceId, note) => trx('customer_credit_ledger').insert({ customer_id: customerId, delta: '20.00', balance_after: '20.00', source: 'adjustment', invoice_id: invoiceId, note });
      // The three notes other writers use for credit that comes back: a payer transfer (two writers) and a void.
      await credit(transferInvoice, 'Bill-To moved to payer 7 — homeowner credit returned');
      await credit(transferInvoice, 'Account credit returned — invoice re-routed to third-party payer');
      await credit(voidedInvoice, 'Account credit returned — invoice S-1 voided');
      await trx('stripe_orphan_charges').insert({
        stripe_payment_intent_id: 'pi_won:dispute-won:du_1:inv', stripe_charge_id: 'ch_won', amount: '20.00', source: 'combined_pay_webhook',
        original_db_error: 'Dispute du_1 won reinstated $20.00 for invoice x, but a replacement payment owns the invoice — credit or refund the reinstated share manually',
      });
      const found = await signals([transfer, voided, won]);
      expect(found.get(transfer)).toEqual([]);
      expect(found.get(voided)).toEqual([]);
      expect(found.get(won)).toEqual([]);
    });

    it('reads the credit row a full refund writes, by exactly the note the writer builds', async () => {
      const id = await tech('Sample Alpha');
      const customerId = await customer();
      const visit = await stop(id, W1, '100.00', customerId);
      const invoiceId = await invoiceFor(customerId, '100.00', { scheduled_service_id: visit });
      const number = (await trx('invoices').where({ id: invoiceId }).first('invoice_number')).invoice_number;
      const [row] = await trx('customer_credit_ledger').insert({
        customer_id: customerId, delta: '20.00', balance_after: '20.00', source: 'adjustment', invoice_id: invoiceId, note: refundCreditNote({ invoice_number: number, id: invoiceId }),
      }).returning('id');
      expect((await signals([visit])).get(visit)).toEqual([`credit:${row.id}`]);
    });
  });

  describe('payment state, durable invoice keys, partial disputes, and big lists', () => {
    it('puts a disputed or refunded status in the signal beside a refund amount, so a chargeback after a partial refund is a new signal', async () => {
      const id = await tech('Sample Alpha');
      const customerId = await customer();
      const visit = await stop(id, W1, '100.00', customerId);
      await invoiceFor(customerId, '100.00', { scheduled_service_id: visit, stripe_payment_intent_id: 'pi_cb' });
      const payment = await paymentOf(customerId, { stripe_payment_intent_id: 'pi_cb', refund_amount: '10.00' });
      expect((await signals([visit])).get(visit)).toEqual([`pay:${payment}:1000`]);
      await trx('payments').where({ id: payment }).update({ status: 'disputed' });
      expect((await signals([visit])).get(visit)).toEqual([`pay:${payment}:1000:disputed`]);
      await trx('payments').where({ id: payment }).update({ status: 'refunded' });
      expect((await signals([visit])).get(visit)).toEqual([`pay:${payment}:1000:refunded`]);
    });

    it('reopens an answered take-back when the refunded payment is charged back', async () => {
      const world = await paidWorld('cb2');
      const payment = await refundOn(world, '30.00');
      const open = await week(world, W2, '500.00');
      await takeBack({ checkId: world.checkId, visitId: world.visit, cents: 30000, signals: open.takeBackToSet[0].newSignals });
      expect((await preview(world.id, W2)).takeBackToSet).toEqual([]);
      await trx('payments').where({ id: payment }).update({ status: 'disputed' });
      const shown = await preview(world.id, W2);
      expect(shown.takeBackToSet).toEqual([expect.objectContaining({ reason: 'new', previousCents: 30000, newSignals: [`pay:${payment}:3000:disputed`] })]);
    });

    it('ties a payment to its invoice by dispute_invoice_id and waves_invoice_id, as the webhook does, when the invoice kept no Stripe id', async () => {
      const id = await tech('Sample Alpha');
      const customerId = await customer();
      const reopened = await stop(id, W1, '100.00', customerId);
      const tagged = await stop(id, W1, '100.00', customerId);
      const reopenedInvoice = await invoiceFor(customerId, '100.00', { scheduled_service_id: reopened, status: 'sent' });
      const taggedInvoice = await invoiceFor(customerId, '100.00', { scheduled_service_id: tagged, status: 'sent' });
      // A dispute reopen clears the invoice's Stripe ids and writes dispute_invoice_id on the payment.
      const a = await paymentOf(customerId, { metadata: JSON.stringify({ dispute_invoice_id: reopenedInvoice }), refund_amount: '10.00', status: 'disputed' });
      const b = await paymentOf(customerId, { metadata: JSON.stringify({ waves_invoice_id: taggedInvoice }), refund_amount: '5.00' });
      const found = await signals([reopened, tagged]);
      expect(found.get(reopened)).toEqual([`pay:${a}:1000:disputed`]);
      expect(found.get(tagged)).toEqual([`pay:${b}:500`]);
    });

    it('flags an OPEN partial dispute parked on a combined charge, and stops when it is resolved (won), but keeps a lost one', async () => {
      const id = await tech('Sample Alpha');
      const customerId = await customer();
      const visit = await stop(id, W1, '100.00', customerId);
      await invoiceFor(customerId, '100.00', { scheduled_service_id: visit, stripe_charge_id: 'ch_pd', stripe_payment_intent_id: 'pi_pd' });
      const [open] = await trx('stripe_orphan_charges').insert({
        stripe_payment_intent_id: 'pi_pd:partial-dispute:du_1', stripe_charge_id: 'ch_pd', amount: '20.00', source: 'combined_pay_webhook',
        original_db_error: 'Partial dispute du_1 on a combined balance charge',
      }).returning('id');
      expect((await signals([visit])).get(visit)).toEqual([`orphan:${open.id}`]);
      // Closed won or warning_closed: the webhook resolves the case, Stripe restored the money.
      await trx('stripe_orphan_charges').where({ id: open.id }).update({ resolved: true, resolved_at: new Date() });
      expect((await signals([visit])).get(visit)).toEqual([]);
      // Closed lost: the case stays open (money gone) and keeps flagging.
      const [lost] = await trx('stripe_orphan_charges').insert({
        stripe_payment_intent_id: 'pi_pd:partial-dispute:du_2', stripe_charge_id: 'ch_pd', amount: '20.00', source: 'combined_pay_webhook', original_db_error: 'Partial dispute du_2',
      }).returning('id');
      expect((await signals([visit])).get(visit)).toEqual([`orphan:${lost.id}`]);
    });

    it('reads a very long list of visits in one statement (a single array parameter, not one per id)', async () => {
      const ids = Array.from({ length: 70000 }, () => randomUUID());
      const found = await signals(ids);
      expect(found.size).toBe(70000);
      expect([...found.values()].every((list) => list.length === 0)).toBe(true);
    });
  });

  describe('a parked refund the bank bounced is not a refund signal', () => {
    it('skips a parked refund whose id is fenced as failed, and keeps a reconciled one', async () => {
      const id = await tech('Sample Alpha');
      const customerId = await customer();
      const visit = await stop(id, W1, '100.00', customerId);
      await invoiceFor(customerId, '100.00', { scheduled_service_id: visit, stripe_charge_id: 'ch_p' });
      const parked = (key, patch = {}) => trx('stripe_orphan_charges').insert({
        stripe_payment_intent_id: `pi_p:partial-refund:${key}`, stripe_charge_id: 'ch_p', amount: '10.00', source: 'combined_pay_webhook',
        original_db_error: `Partial refund ${key} of $10 on a combined balance charge`, ...patch,
      }).returning('id');
      const [bounced] = await parked('re_bounced');
      await trx('stripe_failed_refunds').insert({ stripe_refund_id: 're_bounced', stripe_charge_id: 'ch_p' });
      expect(bounced).toBeTruthy();
      expect((await signals([visit])).get(visit)).toEqual([]);
      // Reconciled successfully (resolved, no failure marker): still a refund that happened.
      const [kept] = await parked('re_ok', { resolved: true, resolution_notes: 'Reconciled by the office' });
      expect((await signals([visit])).get(visit)).toEqual([`orphan:${kept.id}`]);
    });
  });

  describe('a refund an owner credit was set against, compared by equality (own week)', () => {
    it('puts the owner\'s credit aside when a refund he saw is gone, and names that as the cause', async () => {
      const id = await tech('Sample Alpha');
      await settings(id);
      const customerId = await customer();
      const visit = await stop(id, W1, '100.00', customerId);
      await invoiceFor(customerId, '100.00', { scheduled_service_id: visit, stripe_payment_intent_id: 'pi_gone' });
      const payment = await paymentOf(customerId, { stripe_payment_intent_id: 'pi_gone', refund_amount: '10.00' });
      expect((await override({ technicianId: id, visitId: visit, weekStart: W1, creditCents: 9000, reason: 'Refund was $10' })).status).toBe(200);
      expect(rowOf(await preview(id, W1), visit)).toMatchObject({ kind: 'owner_set', creditCents: 9000 });
      await trx('payments').where({ id: payment }).update({ refund_amount: '0.00' });
      expect(rowOf(await preview(id, W1), visit)).toMatchObject({ kind: 'owner_override_refund_changed', creditCents: 0, reason: expect.stringMatching(/is gone/) });
    });
  });

  describe('the owner\'s answers are compared and frozen', () => {
    it('refuses a change or a clear that names another answer than the stored one, and accepts the current one', async () => {
      const world = await paidWorld('rev2');
      await refundOn(world, '30.00');
      const open = await week(world, W2, '500.00');
      const { newSignals, answerRevision } = open.takeBackToSet[0];
      expect(answerRevision).toBe('none');
      const body = { checkId: world.checkId, visitId: world.visit, signals: newSignals };
      // Two tabs loaded the same week; the first saves, the second still says 'none'.
      expect((await takeBack({ ...body, cents: 30000, answerRevision: 'none' })).status).toBe(200);
      const stale = await takeBack({ ...body, cents: 40000, answerRevision: 'none' });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatch(/changed since you loaded/);
      const shown = (await preview(world.id, W2)).takeBackAnswers[0];
      expect(shown.answerRevision).toMatch(/^\d+:\d{4}-\d{2}-\d{2}T/);
      // A clear with the wrong revision is refused, and so is a change; the answer stays.
      const wrong = { answerRevision: '0:1999-01-01T00:00:00.000000' };
      expect((await api('DELETE', '/production-share/refund-take-back', { body: { checkId: world.checkId, visitId: world.visit, ...wrong } })).status).toBe(409);
      expect((await takeBack({ ...body, cents: 40000, ...wrong })).status).toBe(409);
      expect(await revisionNow(world.checkId, world.visit)).toBe(shown.answerRevision);
      // A missing revision is a plain refusal.
      expect((await api('PUT', '/production-share/refund-take-back', { body })).status).toBe(400);
      expect((await takeBack({ ...body, cents: 40000, answerRevision: shown.answerRevision })).status).toBe(200);
      expect((await api('DELETE', '/production-share/refund-take-back', { body: { checkId: world.checkId, visitId: world.visit, answerRevision: await revisionNow(world.checkId, world.visit) } })).status).toBe(200);
    });

    it('freezes the answers a week used, so a changed answer makes the draft stale even when the credit moved is the same', async () => {
      const world = await paidWorld('freeze2');
      await refundOn(world, '30.00');
      await stop(world.id, W2, '100.00', world.customerId);
      const open = await preview(world.id, W2);
      await takeBack({ checkId: world.checkId, visitId: world.visit, cents: 30000, signals: open.takeBackToSet[0].newSignals });
      const draftRun = (await draft(W2)).body.run;
      // Only $100.00 of credit: $300.00 and $400.00 both take $100.00 this week.
      const stored = await trx('payroll_checks').where({ id: byName(draftRun, 'Sample Alpha').id }).first('calc_snapshot');
      expect(stored.calc_snapshot.productionShare.refundAnswers).toEqual([expect.objectContaining({ sourceCheckId: world.checkId, visitId: world.visit, cents: 30000, revision: expect.any(String) })]);
      expect(stored.calc_snapshot.productionShare.takeBacks[0].cents).toBe(10000);
      await takeBack({ checkId: world.checkId, visitId: world.visit, cents: 40000, signals: open.takeBackToSet[0].newSignals });
      const view = (await api('GET', `/runs/${draftRun.id}`)).body.run;
      expect(view.stale).toBe(true);
      expect((await finalize(draftRun.id, draftRun.token)).status).toBe(409);
    });
  });

  describe('the refund take-back routes', () => {
    it('refuses a total below 0, a check that is not final, a stop not on the check, a stale page and anyone but the owner account', async () => {
      const world = await paidWorld('route');
      const payment = await refundOn(world, '30.00');
      const signalsNow = [`pay:${payment}:3000`];
      const base = { checkId: world.checkId, visitId: world.visit, signals: signalsNow };
      expect((await takeBack({ ...base, cents: -1 })).status).toBe(400);
      expect((await takeBack({ ...base, cents: 1.5 })).status).toBe(400);
      expect((await takeBack({ ...base, cents: 100 }, undefined)).status).toBe(200);
      // A stop that is not on the check, and a check that does not exist.
      expect((await takeBack({ ...base, visitId: randomUUID(), cents: 100 })).status).toBe(400);
      expect((await takeBack({ ...base, checkId: randomUUID(), cents: 100 })).status).toBe(404);
      // A check of a draft run is not final.
      await stop(world.id, W2, '500.00', world.customerId);
      const draftRun = (await draft(W2)).body.run;
      const draftCheck = byName(draftRun, 'Sample Alpha').id;
      const notFinal = await takeBack({ checkId: draftCheck, visitId: world.visit, cents: 100, signals: signalsNow });
      expect(notFinal.status).toBe(409);
      expect(notFinal.body.error).toMatch(/not final/);
      // A refund the page did not see.
      expect((await takeBack({ ...base, signals: [], cents: 100 })).status).toBe(409);
      // Another login than the owner account.
      const other = await fetch(`${baseUrl}/production-share/refund-take-back`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-test-admin': ADMIN_ID, 'x-test-email': 'someone@example.test' },
        body: JSON.stringify({ ...base, cents: 100 }),
      });
      expect(other.status).toBe(403);
      const cleared = await fetch(`${baseUrl}/production-share/refund-take-back?checkId=${world.checkId}&visitId=${world.visit}`, {
        method: 'DELETE', headers: { 'x-test-admin': ADMIN_ID, 'x-test-email': 'someone@example.test' },
      });
      expect(cleared.status).toBe(403);
      // The audit event of an answer names who, what and how much.
      const audit = await trx('audit_log').where({ action: 'payroll.production_share_refund_take_back_set' }).first();
      expect(audit.metadata).toMatchObject({ cents: 100, visit_id: world.visit });
      expect((await api('DELETE', '/production-share/refund-take-back', { body: { checkId: world.checkId, visitId: randomUUID(), answerRevision: 'none' } })).status).toBe(404);
    });
  });
});
