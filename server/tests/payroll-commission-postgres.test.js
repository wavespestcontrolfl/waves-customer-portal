// Real PostgreSQL transactions (rolled back): the commission ledger (D5 part 3b-2). Customer
// payments on a technician's sales (estimates.sold_by_technician_id) become commission pay
// lines on pay runs, behind GATE_PAYROLL_COMMISSION_LEDGER (which needs GATE_PAYROLL_PAY_LINES).
// The lines are derived data, re-synced when a run is drafted, recomputed and finalized: 10% of
// what Waves collects for the new service only, in the first 12 months, net of tax, the card
// surcharge and refunds; a refund comes off the next commission, never below $0, never from wages.
// Refunds are read from the payment row (status, refund_amount, refunded_surcharge_cents) with no date condition.
// All names are synthetic. DATABASE_URL-gated like the other *-postgres suites.
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

jest.setTimeout(60000);

// Finished staff weeks in 2026 (Monday dates). Pay dates default to the Friday after.
const W1 = '2026-09-14'; // runs through Sunday 2026-09-20
const W2 = '2026-09-21';
const W3 = '2026-09-28';
const W4 = '2026-10-05';
// Accepted Monday 2026-08-10 (ET): the 12 months run through 2027-08-09.
const ACCEPTED = '2026-08-10T15:00:00Z';

const GATES = ['GATE_PAYROLL', 'GATE_PAYROLL_PAY_LINES', 'GATE_PAYROLL_REVIEW_BONUS_IMPORT', 'GATE_PAYROLL_COMMISSION_LEDGER',
  'GATE_PAYROLL_FORM_FIGURES', 'GATE_PAYROLL_TIME_OFF', 'GATE_SHIFT_CLOSE_REVIEW'];
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

postgres('payroll commission ledger', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  let counter = 0;
  const OLD = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
  const ADMIN_ID = randomUUID();

  const addDays = (ymd, n) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const readyTech = async (name, patch = {}) => {
    const id = randomUUID();
    await trx('technicians').insert({
      id, name, employment_type: 'w2', employment_status: 'active', pay_rate: '22.00', ...patch,
    });
    await trx('payroll_w4_elections').insert({
      technician_id: id, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    });
    return id;
  };
  const approvedWeek = (technicianId, weekStart) => trx('time_weekly_summary').insert({
    technician_id: technicianId, week_start: weekStart, week_end: addDays(weekStart, 6), status: 'approved',
    regular_minutes: '2400.00', overtime_minutes: '0.00',
  });
  const idOf = (row) => (row && row.id ? row.id : row);
  const customer = async (first = 'Pat', last = 'Sample') => {
    counter += 1;
    const [row] = await trx('customers').insert({
      first_name: first, last_name: last, phone: `+1941555${String(1000 + counter).padStart(4, '0')}`,
    }).returning('id');
    return idOf(row);
  };
  const estimate = async (customerId, soldBy, patch = {}) => {
    const [row] = await trx('estimates').insert({
      customer_id: customerId, status: 'accepted', accepted_at: ACCEPTED,
      sold_by_technician_id: soldBy, sold_by_source: soldBy ? 'office' : null, ...patch,
    }).returning('id');
    return idOf(row);
  };
  const visit = async (customerId, estimateId, patch = {}) => {
    const [row] = await trx('scheduled_services').insert({
      customer_id: customerId, scheduled_date: '2026-08-20', service_type: 'Sample pest control', source_estimate_id: estimateId, ...patch,
    }).returning('id');
    return idOf(row);
  };
  const invoice = async (customerId, patch = {}) => {
    counter += 1;
    const subtotal = patch.subtotal ?? '100.00';
    const tax = patch.tax_amount ?? '0.00';
    const [row] = await trx('invoices').insert({
      token: randomUUID().replace(/-/g, ''), invoice_number: `WPC-T${counter}`, customer_id: customerId,
      subtotal, tax_amount: tax, discount_amount: '0.00', total: (Number(subtotal) + Number(tax)).toFixed(2),
      line_items: JSON.stringify([]), ...patch,
    }).returning('id');
    return idOf(row);
  };
  const mintedInvoice = (customerId, estimateId, patch = {}) => invoice(customerId, {
    notes: `Auto-generated from accepted estimate #${estimateId}`, ...patch,
  });
  const payment = async (customerId, invoiceId, on, amount, patch = {}) => {
    const [row] = await trx('payments').insert({
      customer_id: customerId, payment_date: on, amount, status: 'paid', base_amount_cents: Math.round(Number(amount) * 100),
      metadata: invoiceId ? JSON.stringify({ invoice_id: invoiceId }) : null, ...patch,
    }).returning('id');
    return idOf(row);
  };
  const api = async (method, path, { body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-admin': ADMIN_ID },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const draft = (weekStart) => api('POST', '/runs', { body: { weekStart } });
  const recompute = (runId) => api('POST', `/runs/${runId}/recompute`);
  const finalizeWith = (runId, token) => api('POST', `/runs/${runId}/finalize`, { body: { token } });
  const finalize = async (runId) => {
    const shown = await api('GET', `/runs/${runId}`);
    return finalizeWith(runId, shown.body.run.token);
  };
  const voidRun = (runId) => api('POST', `/runs/${runId}/void`, { body: { reason: 'Sample correction' } });
  const byName = (run, name) => run.checks.find((c) => c.name === name);
  const ledgerLines = () => trx('payroll_pay_lines').where({ source_type: 'commission_payment' }).orderBy('created_at').orderBy('id');
  const sales = () => trx('commission_sales').orderBy('created_at').orderBy('id');
  const entries = () => trx('commission_entries').orderBy('payment_on').orderBy('id');
  const syncEvents = () => trx('audit_log').where({ action: 'payroll.commission_lines_synced' });
  const dateOnly = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
  const commissionOf = (run, name) => byName(run, name).commissionCents;

  // A tech with approved hours, a customer, and one accepted estimate they sold.
  const soldWorld = async (techName = 'Sample Alpha', customerName = ['Pat', 'Sample'], techPatch = {}) => {
    const tech = await readyTech(techName, techPatch);
    await approvedWeek(tech, W1);
    const cust = await customer(...customerName);
    const est = await estimate(cust, tech);
    return { tech, cust, est };
  };

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
    jest.clearAllMocks();
    process.env.GATE_PAYROLL = 'true';
    process.env.GATE_PAYROLL_PAY_LINES = 'true';
    process.env.GATE_PAYROLL_COMMISSION_LEDGER = 'true';
    delete process.env.GATE_PAYROLL_REVIEW_BONUS_IMPORT;
    delete process.env.GATE_PAYROLL_FORM_FIGURES;
    delete process.env.GATE_PAYROLL_TIME_OFF;
    trx = await database.transaction();
    mockConnection = trx;
    await trx('technicians').insert({ id: ADMIN_ID, name: 'Sample Admin', role: 'admin', employment_type: '1099', employment_status: 'active' });
  });
  afterEach(async () => {
    await trx.rollback();
    for (const name of GATES) {
      if (OLD[name] === undefined) delete process.env[name]; else process.env[name] = OLD[name];
    }
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  describe('a new customer', () => {
    it('pays 10% of the pre-tax cash of a prepaid year in the next run, never the card surcharge', async () => {
      const { tech, cust, est } = await soldWorld();
      const inv = await mintedInvoice(cust, est, { subtotal: '600.00', total: '600.00' });
      // $600 plus an $18 card surcharge: base_amount_cents is the part that counts.
      const pay = await payment(cust, inv, '2026-09-16', '618.00', { base_amount_cents: 60000, surcharge_amount_cents: 1800 });

      const created = await draft(W1);
      expect(created.status).toBe(201);
      const check = byName(created.body.run, 'Sample Alpha');
      expect(check).toMatchObject({ commissionCents: 6000, regularPayCents: 88000, grossCents: 94000 });

      const [sale] = await sales();
      expect(sale).toMatchObject({ estimate_id: est, technician_id: tech, customer_id: cust, rate_bps: 1000 });
      expect(dateOnly(sale.accepted_on)).toBe('2026-08-10');
      expect(dateOnly(sale.window_end)).toBe('2027-08-09');
      const [entry] = await entries();
      expect(entry).toMatchObject({ sale_id: sale.id, payment_id: pay, technician_id: tech });
      expect([Number(entry.counted_cents), Number(entry.commission_cents)]).toEqual([60000, 6000]);

      const lines = await ledgerLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        technician_id: tech, kind: 'commission', amount_cents: 6000, status: 'open', source_type: 'commission_payment',
        source_id: `${entry.id}:1`, note: 'Commission: Pat S., payment Sep 16', created_by: null,
      });
      expect([dateOnly(lines[0].earned_week_start), dateOnly(lines[0].covers_from), dateOnly(lines[0].covers_to)])
        .toEqual([W1, '2026-08-10', '2026-09-16']);

      // One critical audit event with ids and counts, never an amount or a customer name.
      const events = await syncEvents();
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toMatchObject({ week_end: '2026-09-20', added_count: 1, removed_count: 0, sales_added: 1, entries_added: 1 });
      const metaText = JSON.stringify(events[0].metadata).replace(UUID_G, '<id>');
      expect(metaText).not.toMatch(/6000|60000|amount|Pat|Sample/);
    });

    it('pays one line per payment on per-application visits, each covering from the sale week', async () => {
      const { tech, cust, est } = await soldWorld();
      await approvedWeek(tech, W3);
      const lineFor = (visitId) => JSON.stringify([{ client_id: `scheduled_${visitId}_primary`, description: 'Pest control', amount: 80 }]);
      const days = [['2026-09-02', 'a'], ['2026-09-16', 'b'], ['2026-09-30', 'c']];
      for (const [on] of days) {
        const v = await visit(cust, est, { scheduled_date: on });
        const inv = await invoice(cust, { subtotal: '80.00', scheduled_service_id: v, line_items: lineFor(v) });
        await payment(cust, inv, on, '80.00');
      }
      const first = await draft(W1);
      expect(first.status).toBe(201);
      expect(commissionOf(first.body.run, 'Sample Alpha')).toBe(1600);
      const lines = await ledgerLines();
      expect(lines.map((l) => [l.amount_cents, dateOnly(l.covers_from), dateOnly(l.covers_to)]).sort())
        .toEqual([[800, '2026-08-10', '2026-09-02'], [800, '2026-08-10', '2026-09-16']]);
      expect((await finalize(first.body.run.id)).status).toBe(200);
      // The third payment waits for its own week.
      const third = await draft(W3);
      expect(third.status).toBe(201);
      expect(commissionOf(third.body.run, 'Sample Alpha')).toBe(800);
      expect(await entries()).toHaveLength(3);
    });

    it('takes sales tax out of a commercial invoice', async () => {
      const { cust, est } = await soldWorld();
      const inv = await mintedInvoice(cust, est, { subtotal: '1000.00', tax_amount: '70.00' });
      await payment(cust, inv, '2026-09-16', '1070.00');
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(10000);
      expect(Number((await entries())[0].counted_cents)).toBe(100000);
    });

    it('rounds half up in whole cents', async () => {
      const { cust, est } = await soldWorld();
      // 1.05 x 10% = 10.5 cents: half up is 11.
      const inv = await mintedInvoice(cust, est, { subtotal: '1.05' });
      await payment(cust, inv, '2026-09-16', '1.05');
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(11);
    });
  });

  describe('an existing customer\'s add-on', () => {
    it('pays only the add-on lines of a host visit invoice: $240 of $840 earns $24', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, W1);
      const cust = await customer('Dana', 'Sample');
      const est = await estimate(cust, tech);
      const host = await visit(cust, null);
      const [addon] = await trx('scheduled_service_addons').insert({
        scheduled_service_id: host, service_name: 'Sample add-on', area_addon_scope: JSON.stringify({ sourceEstimateId: est }),
      }).returning('id');
      const addonId = idOf(addon);
      const inv = await invoice(cust, {
        subtotal: '840.00', scheduled_service_id: host,
        line_items: JSON.stringify([
          { client_id: `scheduled_${host}_primary`, description: 'Host service', amount: 600 },
          { client_id: `scheduled_${host}_addon_${addonId}`, description: 'Sample add-on', amount: 240 },
        ]),
      });
      await payment(cust, inv, '2026-09-16', '840.00');
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(2400);
      expect(Number((await entries())[0].counted_cents)).toBe(24000);
    });

    it('counts nothing for a host visit whose estimate was sold by nobody', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, W1);
      const cust = await customer();
      const unsold = await estimate(cust, null);
      const host = await visit(cust, unsold);
      const inv = await invoice(cust, {
        scheduled_service_id: host, line_items: JSON.stringify([{ client_id: `scheduled_${host}_primary`, amount: 100 }]),
      });
      await payment(cust, inv, '2026-09-16', '100.00');
      const created = await draft(W1);
      expect(byName(created.body.run, 'Sample Alpha')).toMatchObject({ commissionCents: 0 });
      expect(await sales()).toHaveLength(0);
    });
  });

  describe('which invoice a payment belongs to', () => {
    it('links by metadata, by PaymentIntent only, and by manual description only, and counts a combined PaymentIntent once per invoice', async () => {
      const { cust, est } = await soldWorld();
      const mk = (patch = {}) => mintedInvoice(cust, est, patch);
      const byMeta = await mk();
      await mk({ stripe_payment_intent_id: 'pi_sample_single' });
      await mk({ invoice_number: 'WPC-MANUAL1' });
      const comboA = await mk({ stripe_payment_intent_id: 'pi_sample_combo' });
      const comboB = await mk({ stripe_payment_intent_id: 'pi_sample_combo' });
      const elsewhere = await invoice(cust, { subtotal: '100.00' });
      await payment(cust, byMeta, '2026-09-15', '100.00');
      await payment(cust, null, '2026-09-15', '100.00', { stripe_payment_intent_id: 'pi_sample_single' });
      await payment(cust, null, '2026-09-15', '100.00', { description: 'Invoice WPC-MANUAL1 — cash' });
      await payment(cust, comboA, '2026-09-15', '100.00', { stripe_payment_intent_id: 'pi_sample_combo' });
      await payment(cust, comboB, '2026-09-15', '100.00', { stripe_payment_intent_id: 'pi_sample_combo' });
      // Tagged for another invoice that is not the estimate's: not counted, whatever its PaymentIntent says.
      await payment(cust, elsewhere, '2026-09-15', '100.00', { stripe_payment_intent_id: 'pi_sample_single' });
      // A manual description for an invoice that is not the estimate's.
      await payment(cust, null, '2026-09-15', '100.00', { description: `Invoice ${await trx('invoices').where({ id: elsewhere }).first().then((r) => r.invoice_number)} — cash` });
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(5 * 1000);
      expect(await entries()).toHaveLength(5);
    });

    it('skips a payment on a PaymentIntent two invoices share when the row names neither', async () => {
      const { cust, est } = await soldWorld();
      await mintedInvoice(cust, est, { stripe_payment_intent_id: 'pi_sample_shared' });
      await invoice(cust, { stripe_payment_intent_id: 'pi_sample_shared' });
      await payment(cust, null, '2026-09-15', '100.00', { stripe_payment_intent_id: 'pi_sample_shared' });
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(0);
    });

    it('counts a paid payment, and not a disputed one, a refunded one with no refund amount, or any other status', async () => {
      const { cust, est } = await soldWorld();
      const inv = await mintedInvoice(cust, est, { subtotal: '700.00' });
      for (const status of ['processing', 'disputed', 'canceled', 'failed', 'upcoming', 'refunded']) {
        await payment(cust, inv, '2026-09-15', '100.00', { status });
      }
      await payment(cust, inv, '2026-09-15', '100.00', { status: 'paid' });
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(1000);
      expect(await entries()).toHaveLength(1);
    });
  });

  describe('the 12 months', () => {
    it('counts a payment on the last day and the first day, not the day after or before acceptance', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, W1);
      const cust = await customer();
      // Accepted Monday 2025-09-15: the 12 months end Monday 2026-09-14.
      const est = await estimate(cust, tech, { accepted_at: '2025-09-15T15:00:00Z' });
      const inv = await mintedInvoice(cust, est, { subtotal: '400.00' });
      await payment(cust, inv, '2025-09-14', '100.00');
      await payment(cust, inv, '2025-09-15', '100.00');
      await payment(cust, inv, '2026-09-14', '100.00');
      await payment(cust, inv, '2026-09-15', '100.00');
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(2000);
      const [sale] = await sales();
      expect(dateOnly(sale.window_end)).toBe('2026-09-14');
      expect((await entries()).map((e) => dateOnly(e.payment_on))).toEqual(['2025-09-15', '2026-09-14']);
    });

    it('uses the Eastern date of the acceptance', async () => {
      const tech = await readyTech('Sample Alpha');
      const cust = await customer();
      // 2026-08-11 01:00Z is Monday 2026-08-10 21:00 Eastern.
      await estimate(cust, tech, { accepted_at: '2026-08-11T01:00:00Z' });
      await approvedWeek(tech, W1);
      await draft(W1);
      const [sale] = await sales();
      expect(dateOnly(sale.accepted_on)).toBe('2026-08-10');
    });

    it('writes a sale only for an estimate that was accepted, by a W-2 technician, by the week end', async () => {
      const tech = await readyTech('Sample Alpha');
      const contractor = await readyTech('Sample Contractor', { employment_type: '1099' });
      await approvedWeek(tech, W1);
      const cust = await customer();
      await estimate(cust, contractor);
      await estimate(cust, tech, { accepted_at: null, status: 'sent' });
      await estimate(cust, tech, { accepted_at: '2026-09-21T15:00:00Z' });
      const ok = await estimate(cust, tech);
      await draft(W1);
      expect((await sales()).map((s) => s.estimate_id)).toEqual([ok]);
    });

    it('never changes or deletes a sale', async () => {
      const { est } = await soldWorld();
      await draft(W1);
      const [sale] = await sales();
      const attempt = (fn) => trx.transaction(fn).then(() => null, (err) => err);
      expect((await attempt((inner) => inner('commission_sales').where({ id: sale.id }).update({ rate_bps: 2000 })))?.message)
        .toMatch(/cannot be changed or deleted/);
      expect((await attempt((inner) => inner('commission_sales').where({ id: sale.id }).del()))?.message)
        .toMatch(/cannot be changed or deleted/);
      // A later change of Sold by never moves the sale.
      await trx('estimates').where({ id: est }).update({ sold_by_technician_id: null, sold_by_source: 'cleared' });
      const [run] = await trx('payroll_runs').select('id');
      expect((await recompute(run.id)).status).toBe(200);
      expect((await sales())[0]).toMatchObject({ id: sale.id, technician_id: sale.technician_id });
    });
  });

  describe('refunds, read from the payment row', () => {
    // Sells one more estimate for the customer; returns its invoice.
    const soldAgain = async (cust, tech, acceptedAt, subtotal = '1000.00') => {
      const est = await estimate(cust, tech, { accepted_at: acceptedAt });
      return mintedInvoice(cust, est, { subtotal });
    };
    const threeWeeks = async (tech) => { for (const week of [W1, W2, W3]) await approvedWeek(tech, week); };
    const refund = (paymentId, amount, patch = {}) => trx('payments').where({ id: paymentId })
      .update({ status: 'refunded', refund_amount: amount, ...patch });
    const entryOf = async (paymentId) => {
      const [entry] = await trx('commission_entries').where({ payment_id: paymentId });
      return entry && [Number(entry.counted_cents), Number(entry.commission_cents)];
    };

    it('takes a partial refund off the next commission, never below $0, never from wages', async () => {
      const tech = await readyTech('Sample Alpha');
      await threeWeeks(tech);
      const cust = await customer();
      const firstPayment = await payment(cust, await soldAgain(cust, tech, ACCEPTED), '2026-09-16', '1000.00');
      const run1 = await draft(W1);
      expect(commissionOf(run1.body.run, 'Sample Alpha')).toBe(10000);
      expect((await finalize(run1.body.run.id)).status).toBe(200);

      // $400 of it is refunded; the next sale pays $50, so $40 of the $100 already paid comes off it.
      await refund(firstPayment, '400.00');
      await payment(cust, await soldAgain(cust, tech, '2026-09-14T15:00:00Z'), '2026-09-23', '500.00');
      const run2 = await draft(W2);
      const check2 = byName(run2.body.run, 'Sample Alpha');
      expect(check2.commissionCents).toBe(1000);
      expect(check2.regularPayCents).toBe(88000);
      expect(check2.grossCents).toBe(88000 + 1000);
      expect(await entryOf(firstPayment)).toEqual([60000, 6000]);
      expect((await finalize(run2.body.run.id)).status).toBe(200);

      // The rest is refunded too: a run with nothing owed has no line and wages stay whole.
      await refund(firstPayment, '1000.00');
      const run3 = await draft(W3);
      const check3 = byName(run3.body.run, 'Sample Alpha');
      expect(check3.commissionCents).toBe(0);
      expect(check3.regularPayCents).toBe(88000);
      expect(check3.grossCents).toBe(88000);
      expect((await ledgerLines()).filter((l) => l.status === 'open')).toHaveLength(0);
      // The first sale now earns $0 but $100 was paid for it, and the second earned $50 of which $10 was paid:
      // a third sale of $200 earns $250 in all, less the $110 already paid, so $140.
      await payment(cust, await soldAgain(cust, tech, '2026-09-21T15:00:00Z'), '2026-09-29', '2000.00');
      const rerun = await recompute(run3.body.run.id);
      expect(rerun.status).toBe(200);
      expect(commissionOf(rerun.body.run, 'Sample Alpha')).toBe(14000);
    });

    it('counts a fully refunded payment as 0', async () => {
      const { cust, est } = await soldWorld();
      const paid = await payment(cust, await mintedInvoice(cust, est, { subtotal: '1000.00' }), '2026-09-16', '1000.00');
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(10000);
      await refund(paid, '1000.00');
      const again = await recompute(created.body.run.id);
      expect(commissionOf(again.body.run, 'Sample Alpha')).toBe(0);
      expect(await entryOf(paid)).toEqual([0, 0]);
      expect((await ledgerLines()).filter((l) => l.status === 'open')).toHaveLength(0);
    });

    it('takes a refund made after the 12 months ended off the next commission', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, W1);
      await approvedWeek(tech, W2);
      const cust = await customer();
      // Accepted 2025-01-10: the 12 months ended 2026-01-09.
      const oldPayment = await payment(cust, await soldAgain(cust, tech, '2025-01-10T15:00:00Z'), '2025-02-03', '1000.00');
      const run1 = await draft(W1);
      expect(commissionOf(run1.body.run, 'Sample Alpha')).toBe(10000);
      expect((await finalize(run1.body.run.id)).status).toBe(200);

      await refund(oldPayment, '400.00');
      await payment(cust, await soldAgain(cust, tech, '2026-09-14T15:00:00Z', '500.00'), '2026-09-23', '500.00');
      const run2 = await draft(W2);
      // The old entry is $60 now, $100 was paid: $40 comes off the new $50.
      expect(commissionOf(run2.body.run, 'Sample Alpha')).toBe(1000);
      expect(await entryOf(oldPayment)).toEqual([60000, 6000]);
    });

    it('counts a disputed payment as 0, and counts it again when the dispute is won', async () => {
      const { cust, est } = await soldWorld();
      const disputed = await payment(cust, await mintedInvoice(cust, est, { subtotal: '1000.00' }), '2026-09-16', '1000.00', { status: 'disputed' });
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(0);
      expect(await entries()).toHaveLength(0);
      await trx('payments').where({ id: disputed }).update({ status: 'paid' });
      const won = await recompute(created.body.run.id);
      expect(commissionOf(won.body.run, 'Sample Alpha')).toBe(10000);
      await trx('payments').where({ id: disputed }).update({ status: 'disputed' });
      const lost = await recompute(created.body.run.id);
      expect(commissionOf(lost.body.run, 'Sample Alpha')).toBe(0);
    });

    it('reduces each invoice of a combined charge that was refunded in full at its own share', async () => {
      const { cust, est } = await soldWorld();
      const small = await mintedInvoice(cust, est, { subtotal: '100.00' });
      const large = await mintedInvoice(cust, est, { subtotal: '200.00' });
      const combined = { combined_payment: true };
      const rowFor = (invoiceId, amount) => payment(cust, invoiceId, '2026-09-16', amount, {
        metadata: JSON.stringify({ invoice_id: invoiceId, ...combined }), stripe_payment_intent_id: 'pi_sample_combined',
      });
      const smallPayment = await rowFor(small, '100.00');
      const largePayment = await rowFor(large, '200.00');
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(3000);
      // Stripe refunds the whole charge: each row is stamped refunded at its own share.
      await refund(smallPayment, '100.00');
      let again = await recompute(created.body.run.id);
      expect(commissionOf(again.body.run, 'Sample Alpha')).toBe(2000);
      await refund(largePayment, '200.00');
      again = await recompute(created.body.run.id);
      expect(commissionOf(again.body.run, 'Sample Alpha')).toBe(0);
      expect(await entryOf(smallPayment)).toEqual([0, 0]);
      expect(await entryOf(largePayment)).toEqual([0, 0]);
    });

    it('subtracts the refund but not the card surcharge share of it', async () => {
      const { cust, est } = await soldWorld();
      // $1,030 paid ($1,000 + $30 surcharge); $309 refunded of which $9 is surcharge: $300 of the base.
      await payment(cust, await mintedInvoice(cust, est, { subtotal: '1000.00' }), '2026-09-16', '1030.00', {
        base_amount_cents: 100000, status: 'refunded', refund_amount: '309.00', refunded_surcharge_cents: 900,
      });
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(7000);
    });

    it('pays what is still owed on an entry in a second line when its first line paid only part', async () => {
      const tech = await readyTech('Sample Alpha');
      await threeWeeks(tech);
      const cust = await customer();
      const firstPayment = await payment(cust, await soldAgain(cust, tech, ACCEPTED), '2026-09-16', '1000.00');
      const run1 = await draft(W1);
      expect(commissionOf(run1.body.run, 'Sample Alpha')).toBe(10000);
      expect((await finalize(run1.body.run.id)).status).toBe(200);
      // $400 refunded: the first entry earns $60 but $100 was paid, so the second sale pays $60 of its $100.
      await refund(firstPayment, '400.00');
      const secondEstimate = await estimate(cust, tech, { accepted_at: '2026-09-14T15:00:00Z' });
      await payment(cust, await mintedInvoice(cust, secondEstimate, { subtotal: '1000.00' }), '2026-09-23', '1000.00');
      const run2 = await draft(W2);
      expect(commissionOf(run2.body.run, 'Sample Alpha')).toBe(6000);
      expect((await finalize(run2.body.run.id)).status).toBe(200);
      // The refund is reversed: the missing $40 is a second line of the second entry.
      await trx('payments').where({ id: firstPayment }).update({ status: 'paid', refund_amount: '0.00' });
      const run3 = await draft(W3);
      expect(commissionOf(run3.body.run, 'Sample Alpha')).toBe(4000);
      const [secondEntry] = await trx('commission_entries').where({ sale_id: (await trx('commission_sales').where({ estimate_id: secondEstimate }).first()).id });
      expect((await ledgerLines()).map((l) => [l.source_id, l.amount_cents, l.status]).sort())
        .toEqual([[`${secondEntry.id}:1`, 6000, 'paid'], [`${secondEntry.id}:2`, 4000, 'open'], [`${(await entries())[0].id}:1`, 10000, 'paid']].sort());
    });

    it('keeps a reopened :1 line when :2 stays paid, so a void never repeats a source id or pays twice', async () => {
      const tech = await readyTech('Sample Alpha');
      await threeWeeks(tech);
      const cust = await customer();
      const firstPayment = await payment(cust, await soldAgain(cust, tech, ACCEPTED), '2026-09-16', '1000.00');
      const run1 = await draft(W1);
      expect((await finalize(run1.body.run.id)).status).toBe(200);
      await refund(firstPayment, '400.00');
      const secondEstimate = await estimate(cust, tech, { accepted_at: '2026-09-14T15:00:00Z' });
      await payment(cust, await mintedInvoice(cust, secondEstimate, { subtotal: '1000.00' }), '2026-09-23', '1000.00');
      const run2 = await draft(W2);
      expect(commissionOf(run2.body.run, 'Sample Alpha')).toBe(6000);
      expect((await finalize(run2.body.run.id)).status).toBe(200);
      await trx('payments').where({ id: firstPayment }).update({ status: 'paid', refund_amount: '0.00' });
      const run3 = await draft(W3);
      expect(commissionOf(run3.body.run, 'Sample Alpha')).toBe(4000);
      expect((await finalize(run3.body.run.id)).status).toBe(200);

      // The December run (run 2) is voided while January's (run 3) stays: its :1 line reopens and :2 stays paid.
      // (The API makes a later final run be voided first, so this puts the line back the way a void does.)
      const secondEntry = await trx('commission_entries').whereNot({ payment_id: firstPayment }).first();
      const reopened = (await ledgerLines()).find((l) => l.source_id === `${secondEntry.id}:1`);
      await trx('payroll_pay_lines').where({ id: reopened.id }).update({ status: 'open', check_id: null });
      expect((await ledgerLines()).filter((l) => l.source_id.startsWith(secondEntry.id)).map((l) => [l.source_id.split(':')[1], l.status]).sort())
        .toEqual([['1', 'open'], ['2', 'paid']]);

      // The next run re-syncs without a unique violation or a second :2. Earned $200, paid $100 + $40: $60 is
      // still owed, exactly the reopened line, which is kept as it is.
      await approvedWeek(tech, W4);
      const next = await draft(W4);
      expect(next.status).toBe(201);
      expect(commissionOf(next.body.run, 'Sample Alpha')).toBe(6000);
      const open = (await ledgerLines()).filter((l) => l.status === 'open');
      expect(open.map((l) => [l.id, l.source_id])).toEqual([[reopened.id, `${secondEntry.id}:1`]]);
      expect((await finalize(next.body.run.id)).status).toBe(200);
      // Everything earned ($100 + $100) is paid once.
      const paid = (await ledgerLines()).filter((l) => l.status === 'paid').reduce((sum, l) => sum + l.amount_cents, 0);
      expect(paid).toBe(20000);
    });
  });

  describe('discounts on an invoice that carries other lines', () => {
    // $600 host service + $240 sold add-on on one host visit invoice. `extra` are discount lines; `patch` the invoice columns.
    const hostInvoice = async (extra, patch, keys = {}) => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, W1);
      const cust = await customer('Dana', 'Sample');
      const est = await estimate(cust, tech);
      const host = await visit(cust, null);
      const [addon] = await trx('scheduled_service_addons').insert({
        scheduled_service_id: host, service_name: 'Sample add-on', area_addon_scope: JSON.stringify({ sourceEstimateId: est }),
      }).returning('id');
      const addonClient = `scheduled_${host}_addon_${idOf(addon)}`;
      const inv = await invoice(cust, {
        subtotal: '840.00', scheduled_service_id: host,
        line_items: JSON.stringify([
          { client_id: `scheduled_${host}_primary`, description: 'Host service', amount: 600, ...keys.host },
          { client_id: addonClient, description: 'Sample add-on', amount: 240, ...keys.addon },
          ...extra(addonClient),
        ]),
        ...patch,
      });
      return { cust, inv };
    };
    const paidCommission = async (cust, inv, amount) => {
      await payment(cust, inv, '2026-09-16', amount);
      const created = await draft(W1);
      expect(created.status).toBe(201);
      return commissionOf(created.body.run, 'Sample Alpha');
    };

    it('takes a discount on the add-on line off its value: $120 off the $240 add-on on $720 paid earns $12', async () => {
      const { cust, inv } = await hostInvoice((id) => [{
        client_id: `discount_x_${id}`, _kind: 'discount', discount_for: id, description: 'Add-on discount', amount: -120,
      }], { discount_amount: '120.00', total: '720.00' });
      expect(await paidCommission(cust, inv, '720.00')).toBe(1200);
    });

    it('spreads a document-wide credit over the lines in proportion to what they are worth', async () => {
      const { cust, inv } = await hostInvoice(() => [{
        client_id: 'discount_custom_appointment', _kind: 'discount', discount_for: null, document_discount: true,
        description: 'Referral credit', amount: -72,
      }], { discount_amount: '72.00', total: '768.00' });
      // $72 over $600 / $240, in whole cents: $51.43 and $20.57 come off, so the add-on is worth $219.43 of $768: $21.94.
      expect(await paidCommission(cust, inv, '768.00')).toBe(2194);
    });

    it('leaves the sold line whole when a document-wide discount is scoped to a service that is not its own', async () => {
      const { cust, inv } = await hostInvoice(() => [{
        client_id: 'discount_custom_appointment', _kind: 'discount', discount_for: null, document_discount: true,
        document_scope_service_key: 'sample_host_service', description: 'Host discount', amount: -72,
      }], { discount_amount: '72.00', total: '768.00' }, {
        host: { service_key: 'sample_host_service' }, addon: { service_key: 'sample_addon_service' },
      });
      // All $72 comes off the host line ($528): the add-on stays $240 of $768: $24.
      expect(await paidCommission(cust, inv, '768.00')).toBe(2400);
    });

    it('spreads a discount that names a line that is gone over the whole document', async () => {
      const { cust, inv } = await hostInvoice(() => [{
        client_id: 'discount_custom_gone', _kind: 'discount', discount_for: 'scheduled_gone_primary',
        description: 'Orphan discount', amount: -72,
      }], { discount_amount: '72.00', total: '768.00' });
      expect(await paidCommission(cust, inv, '768.00')).toBe(2194);
    });
  });

  describe('technicians', () => {
    it('pays a technician who has left, with no hours, until the 12 months end', async () => {
      const tech = await readyTech('Sample Gone', { employment_status: 'inactive' });
      const cust = await customer();
      const est = await estimate(cust, tech);
      await payment(cust, await mintedInvoice(cust, est, { subtotal: '500.00' }), '2026-09-16', '500.00');
      const created = await draft(W1);
      expect(created.status).toBe(201);
      expect(commissionOf(created.body.run, 'Sample Gone')).toBe(5000);
      expect((await finalize(created.body.run.id)).status).toBe(200);
    });

    it('writes no sale for a 1099 technician, and never pays their sale as wages', async () => {
      const contractor = await readyTech('Sample Contractor', { employment_type: '1099' });
      const worker = await readyTech('Sample Alpha');
      await approvedWeek(worker, W1);
      const cust = await customer();
      const est = await estimate(cust, contractor);
      await payment(cust, await mintedInvoice(cust, est), '2026-09-16', '100.00');
      const created = await draft(W1);
      expect(created.status).toBe(201);
      expect(await sales()).toHaveLength(0);
      expect(await ledgerLines()).toHaveLength(0);
    });
  });

  describe('recompute, finalize and void', () => {
    it('never pays twice: recompute adds nothing, finalize marks the line paid, the next run pays nothing', async () => {
      const { cust, est } = await soldWorld();
      await payment(cust, await mintedInvoice(cust, est, { subtotal: '500.00' }), '2026-09-16', '500.00');
      const created = await draft(W1);
      const [before] = await ledgerLines();
      const again = await recompute(created.body.run.id);
      expect(commissionOf(again.body.run, 'Sample Alpha')).toBe(5000);
      // Nothing changed: the same line, and no second audit event.
      expect((await ledgerLines()).map((l) => l.id)).toEqual([before.id]);
      expect(await syncEvents()).toHaveLength(1);

      const done = await finalize(created.body.run.id);
      expect(done.status).toBe(200);
      expect(commissionOf(done.body.run, 'Sample Alpha')).toBe(5000);
      expect(await ledgerLines()).toHaveLength(1);
      expect((await ledgerLines())[0]).toMatchObject({ status: 'paid', check_id: byName(done.body.run, 'Sample Alpha').id });
      await approvedWeek((await trx('technicians').where({ name: 'Sample Alpha' }).first()).id, W2);
      const next = await draft(W2);
      expect(commissionOf(next.body.run, 'Sample Alpha')).toBe(0);
      expect(await ledgerLines()).toHaveLength(1);
      expect(await entries()).toHaveLength(1);
    });

    it('makes a draft stale when a payment arrives before it is finalized, and pays the new one once', async () => {
      const { cust, est } = await soldWorld();
      const inv = await mintedInvoice(cust, est, { subtotal: '500.00' });
      await payment(cust, inv, '2026-09-16', '250.00');
      const created = await draft(W1);
      const reviewed = (await api('GET', `/runs/${created.body.run.id}`)).body.run.token;
      await payment(cust, inv, '2026-09-17', '250.00');
      const stale = await finalizeWith(created.body.run.id, reviewed);
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatch(/Hours or settings changed/);
      const shown = (await api('GET', `/runs/${created.body.run.id}`)).body.run;
      expect(commissionOf(shown, 'Sample Alpha')).toBe(5000);
      expect((await finalize(created.body.run.id)).status).toBe(200);
      expect((await ledgerLines()).map((l) => [l.status, l.amount_cents]).sort()).toEqual([['paid', 2500], ['paid', 2500]]);
    });

    it('puts the lines back on void, and the next run pays them once', async () => {
      const { cust, est } = await soldWorld();
      await payment(cust, await mintedInvoice(cust, est, { subtotal: '500.00' }), '2026-09-16', '500.00');
      const created = await draft(W1);
      expect((await finalize(created.body.run.id)).status).toBe(200);
      const [paid] = await ledgerLines();
      expect((await voidRun(created.body.run.id)).status).toBe(200);
      expect((await ledgerLines())[0]).toMatchObject({ id: paid.id, status: 'open', check_id: null });

      const next = await draft(W1);
      expect(next.status).toBe(201);
      expect(commissionOf(next.body.run, 'Sample Alpha')).toBe(5000);
      expect(await ledgerLines()).toHaveLength(1);
      expect((await finalize(next.body.run.id)).status).toBe(200);
      expect(await ledgerLines()).toHaveLength(1);
      expect((await ledgerLines())[0]).toMatchObject({ status: 'paid', amount_cents: 5000 });
    });
  });

  describe('the gates', () => {
    it('with the ledger gate off, writes no sales or entries and takes every open ledger line off the next run', async () => {
      const { cust, est } = await soldWorld();
      await payment(cust, await mintedInvoice(cust, est, { subtotal: '500.00' }), '2026-09-16', '500.00');
      const created = await draft(W1);
      expect(await ledgerLines()).toHaveLength(1);
      await trx('commission_entries').del();
      await trx.raw('ALTER TABLE commission_sales DISABLE TRIGGER protect_commission_sales');
      await trx('commission_sales').del();
      await trx.raw('ALTER TABLE commission_sales ENABLE TRIGGER protect_commission_sales');

      delete process.env.GATE_PAYROLL_COMMISSION_LEDGER;
      // Finalizing the old numbers is refused: the line came off, so the draft is stale.
      expect((await finalize(created.body.run.id)).status).toBe(409);
      expect(await ledgerLines()).toHaveLength(0);
      const shown = (await api('GET', `/runs/${created.body.run.id}`)).body.run;
      expect(commissionOf(shown, 'Sample Alpha')).toBe(0);
      expect(await sales()).toHaveLength(0);
      expect(await entries()).toHaveLength(0);
      const events = await syncEvents();
      expect(events[events.length - 1].metadata).toMatchObject({ ledger: 'off', removed_count: 1 });
    });

    it('with the ledger gate off, leaves a paid line alone', async () => {
      const { cust, est } = await soldWorld();
      await payment(cust, await mintedInvoice(cust, est, { subtotal: '500.00' }), '2026-09-16', '500.00');
      const created = await draft(W1);
      expect((await finalize(created.body.run.id)).status).toBe(200);
      delete process.env.GATE_PAYROLL_COMMISSION_LEDGER;
      expect((await voidRun(created.body.run.id)).status).toBe(200);
      const redo = await draft(W1);
      expect(commissionOf(redo.body.run, 'Sample Alpha')).toBe(0);
      expect(await ledgerLines()).toHaveLength(0);
      expect(await sales()).toHaveLength(1);
    });

    it('writes nothing at all with the ledger gate off from the start', async () => {
      delete process.env.GATE_PAYROLL_COMMISSION_LEDGER;
      const { cust, est } = await soldWorld();
      await payment(cust, await mintedInvoice(cust, est, { subtotal: '500.00' }), '2026-09-16', '500.00');
      const created = await draft(W1);
      expect(created.status).toBe(201);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(0);
      expect(await sales()).toHaveLength(0);
      expect(await entries()).toHaveLength(0);
      expect(await ledgerLines()).toHaveLength(0);
      expect(await syncEvents()).toHaveLength(0);
    });

    it('with the pay lines gate off, runs no sync: the pay run is today\'s, with no commission figure', async () => {
      const { cust, est } = await soldWorld();
      await payment(cust, await mintedInvoice(cust, est, { subtotal: '500.00' }), '2026-09-16', '500.00');
      // An open ledger line from earlier is left alone too.
      const open = await readyTech('Sample Other');
      await trx('payroll_pay_lines').insert({
        technician_id: open, kind: 'commission', amount_cents: 500, earned_week_start: W1, covers_from: W1, covers_to: W1,
        source_type: 'commission_payment', source_id: `${randomUUID()}:1`, note: 'Sample',
      });
      delete process.env.GATE_PAYROLL_PAY_LINES;
      const created = await draft(W1);
      expect(created.status).toBe(201);
      const check = byName(created.body.run, 'Sample Alpha');
      expect(check).toMatchObject({ regularPayCents: 88000, grossCents: 88000 });
      expect(check).not.toHaveProperty('commissionCents');
      expect(await sales()).toHaveLength(0);
      expect(await entries()).toHaveLength(0);
      expect(await ledgerLines()).toHaveLength(1);
      expect(await syncEvents()).toHaveLength(0);
      expect((await finalize(created.body.run.id)).status).toBe(200);
    });
  });
});
