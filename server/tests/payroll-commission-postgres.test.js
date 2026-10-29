// Real PostgreSQL transactions (rolled back): the commission ledger (D5 part 3b-2). Customer
// payments on a technician's sales (estimates.sold_by_technician_id) become commission pay
// lines on pay runs, behind GATE_PAYROLL_COMMISSION_LEDGER (which needs GATE_PAYROLL_PAY_LINES).
// The lines are derived data, re-synced when a run is drafted, recomputed and finalized: 10% of
// what Waves collects for the new service only, in the first 12 months, net of tax, the card
// surcharge and refunds; a refund comes off the next commission, never below $0, never from wages.
// Refunds are read from the payment row (status, refund_amount, refunded_surcharge_cents). No reliable refund date
// exists, so a refund counts when a pay run sees it while the sale's 12 months run, and is never taken back after them.
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
// The day the tests run on (Eastern): the 12 months of the sale accepted 2026-08-10 run to 2027-08-09, those of the
// sale accepted 2025-01-10 ended 2026-01-09.
const NOW = Date.parse('2026-10-15T16:00:00Z');
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
  let nowSpy;
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
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    trx = await database.transaction();
    mockConnection = trx;
    await trx('technicians').insert({ id: ADMIN_ID, name: 'Sample Admin', role: 'admin', employment_type: '1099', employment_status: 'active' });
  });
  afterEach(async () => {
    nowSpy.mockRestore();
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

    it('counts the price top-up of a sold visit as the visit\'s: $50 primary + $47.20 top-up earns $9.72', async () => {
      const { cust, est } = await soldWorld();
      const v = await visit(cust, est);
      const inv = await invoice(cust, {
        subtotal: '97.20', scheduled_service_id: v,
        line_items: JSON.stringify([
          { client_id: `scheduled_${v}_primary`, description: 'Pest control', amount: 50 },
          { client_id: `scheduled_price_topup_${v}`, description: 'Scheduled price adjustment', amount: 47.2, category: null },
        ]),
      });
      await payment(cust, inv, '2026-09-16', '97.20');
      expect(commissionOf((await draft(W1)).body.run, 'Sample Alpha')).toBe(972);
      expect((await entries()).map((e) => [e.share_own_cents, e.share_all_cents].map(Number))).toEqual([[9720, 9720]]);
    });

    it('spreads a visit\'s scheduled price adjustment over the invoice the way the invoice writer does', async () => {
      const { cust, est } = await soldWorld();
      const sold = await visit(cust, est);
      const other = await visit(cust, null);
      // One invoice for two visits: the sold one at $100, another at $100 brought down $50 to its stamped price. The
      // writer prices that reconciliation row as a document-wide stored stamp (stackInvoiceDocumentDiscounts), so the $50
      // comes off both lines in proportion: the sold visit is $75 of $150.
      const inv = await invoice(cust, {
        subtotal: '200.00', discount_amount: '50.00', total: '150.00', scheduled_service_id: sold,
        line_items: JSON.stringify([
          { client_id: `scheduled_${sold}_primary`, description: 'Sold service', amount: 100 },
          { client_id: `scheduled_${other}_primary`, description: 'Other service', amount: 100 },
          {
            client_id: `discount_scheduled_price_${other}`, _kind: 'discount', discount_for: null, description: 'Scheduled price adjustment',
            amount: -50, discount_dollars: 50, use_stored_discount: true, stored_discount_source: 'scheduled_service',
          },
        ]),
      });
      await payment(cust, inv, '2026-09-16', '150.00');
      expect(commissionOf((await draft(W1)).body.run, 'Sample Alpha')).toBe(750);
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

  describe('an invoice that carries more than one sale', () => {
    it('counts a setup fee claim invoice line by line: $150 of the first sale, $240 of another sale\'s add-on', async () => {
      const alpha = await readyTech('Sample Alpha');
      const beta = await readyTech('Sample Beta');
      await approvedWeek(alpha, W1);
      await approvedWeek(beta, W1);
      const cust = await customer('Dana', 'Sample');
      const plan = await estimate(cust, alpha);
      const addOnSale = await estimate(cust, beta);
      const first = await visit(cust, plan);
      const [addon] = await trx('scheduled_service_addons').insert({
        scheduled_service_id: first, service_name: 'Sample add-on', area_addon_scope: JSON.stringify({ sourceEstimateId: addOnSale }),
      }).returning('id');
      // The first visit's completion invoice also bills the plan's claimed setup fee (complete-scheduled-service.js), and
      // the other sale's add-on rides the same visit.
      const inv = await invoice(cust, {
        subtotal: '390.00', scheduled_service_id: first,
        line_items: JSON.stringify([
          { client_id: `scheduled_${first}_primary`, description: 'Sample pest control', amount: 100 },
          { description: 'One-time setup fee', quantity: 1, unit_price: 50, amount: 50, category: 'Setup fee', secure_claim: true },
          { client_id: `scheduled_${first}_addon_${idOf(addon)}`, description: 'Sample add-on', amount: 240 },
        ]),
      });
      await trx('setup_fee_claims').insert({ invoice_id: inv, scheduled_service_id: first, amount: '50.00', estimate_id: plan });
      await payment(cust, inv, '2026-09-16', '390.00');
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(1500);
      expect(commissionOf(created.body.run, 'Sample Beta')).toBe(2400);
    });

    it('counts only the setup fee and first application lines of an office invoice that names the sale', async () => {
      const { cust, est } = await soldWorld();
      const inv = await invoice(cust, {
        subtotal: '149.00', notes: `Missed setup fee for accepted estimate #${est}`,
        line_items: JSON.stringify([
          { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99, amount: 99 },
          { description: 'Sample product', quantity: 1, unit_price: 50, amount: 50 },
        ]),
      });
      await payment(cust, inv, '2026-09-16', '149.00');
      expect(commissionOf((await draft(W1)).body.run, 'Sample Alpha')).toBe(990);
    });
  });

  describe('a sold add-on whose row Update Details replaces', () => {
    const KEY = 'sample_addon_service';
    // Host visit with a sold $240 add-on row; returns a way to bill $600 + $240 on the host visit as the add-on row stood then.
    const addonWorld = async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, W1);
      await approvedWeek(tech, W2);
      const cust = await customer('Dana', 'Sample');
      const est = await estimate(cust, tech);
      const host = await visit(cust, null);
      const addRow = async () => idOf((await trx('scheduled_service_addons').insert({
        scheduled_service_id: host, service_name: 'Sample add-on', service_key_snapshot: KEY,
        area_addon_scope: JSON.stringify({ sourceEstimateId: est }),
      }).returning('id'))[0]);
      const firstRow = await addRow();
      const bill = (rowId) => invoice(cust, {
        subtotal: '840.00', scheduled_service_id: host,
        line_items: JSON.stringify([
          { client_id: `scheduled_${host}_primary`, description: 'Host service', amount: 600 },
          { client_id: `scheduled_${host}_addon_${rowId}`, description: 'Sample add-on', amount: 240, service_key: KEY },
        ]),
      });
      // Update Details: the row is deleted and inserted again with a new id, same scope, key and host visit.
      const replaceRow = async (oldId) => { await trx('scheduled_service_addons').where({ id: oldId }).del(); return addRow(); };
      return { tech, cust, est, host, firstRow, bill, replaceRow };
    };

    it('stores the invoice, its shares and its cash figures on the entry when the payment is first counted', async () => {
      const { cust, est, firstRow, bill } = await addonWorld();
      const inv = await bill(firstRow);
      const paid = await payment(cust, inv, '2026-09-16', '840.00');
      await draft(W1);
      const [entry] = await trx('commission_entries').where({ payment_id: paid });
      expect(entry.invoice_id).toBe(inv);
      expect([entry.share_own_cents, entry.share_all_cents, entry.pre_tax_cents, entry.tax_cents].map(Number)).toEqual([24000, 84000, 84000, 0]);
      expect((await sales())[0].estimate_id).toBe(est);
    });

    it('keeps the commission of a paid add-on when its row is replaced, with no offset against the next commission', async () => {
      const { tech, cust, firstRow, bill, replaceRow } = await addonWorld();
      const paid = await payment(cust, await bill(firstRow), '2026-09-16', '840.00');
      const run1 = await draft(W1);
      expect(commissionOf(run1.body.run, 'Sample Alpha')).toBe(2400);
      expect((await finalize(run1.body.run.id)).status).toBe(200);

      const secondRow = await replaceRow(firstRow);
      // An invoice billed before the replacement (it still names the old row id) is paid after it.
      const second = await payment(cust, await bill(firstRow), '2026-09-23', '840.00');
      const run2 = await draft(W2);
      expect(commissionOf(run2.body.run, 'Sample Alpha')).toBe(2400);
      const entriesNow = await entries();
      expect(entriesNow.map((e) => [e.payment_id, Number(e.counted_cents), Number(e.commission_cents)]).sort())
        .toEqual([[paid, 24000, 2400], [second, 24000, 2400]].sort());
      // An invoice billed after the replacement names the new row id and is found the same way.
      await payment(cust, await bill(secondRow), '2026-09-24', '840.00');
      const rerun = await recompute(run2.body.run.id);
      expect(commissionOf(rerun.body.run, 'Sample Alpha')).toBe(4800);
      expect(tech).toBeTruthy();
    });

    it('keeps the commission of a paid add-on when its row is deleted afterwards', async () => {
      const { cust, firstRow, bill } = await addonWorld();
      const paid = await payment(cust, await bill(firstRow), '2026-09-16', '840.00');
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(2400);
      await trx('scheduled_service_addons').where({ id: firstRow }).del();
      const again = await recompute(created.body.run.id);
      expect(commissionOf(again.body.run, 'Sample Alpha')).toBe(2400);
      expect((await trx('commission_entries').where({ payment_id: paid }))[0]).toMatchObject({ counted_cents: '24000', commission_cents: '2400' });
    });

    it('never changes an entry when the invoice lines or visits change after the payment was counted', async () => {
      const { cust, firstRow, bill, host } = await addonWorld();
      const inv = await bill(firstRow);
      const paid = await payment(cust, inv, '2026-09-16', '840.00');
      const created = await draft(W1);
      await trx('invoices').where({ id: inv }).update({ line_items: JSON.stringify([]), scheduled_service_id: null });
      await trx('scheduled_services').where({ id: host }).update({ source_estimate_id: null });
      const again = await recompute(created.body.run.id);
      expect(commissionOf(again.body.run, 'Sample Alpha')).toBe(2400);
      expect((await trx('commission_entries').where({ payment_id: paid }))[0]).toMatchObject({ counted_cents: '24000' });
    });

    it('still follows the payment itself: a refund after the row was replaced comes off', async () => {
      const { cust, firstRow, bill, replaceRow } = await addonWorld();
      const paid = await payment(cust, await bill(firstRow), '2026-09-16', '840.00');
      const created = await draft(W1);
      await replaceRow(firstRow);
      await trx('payments').where({ id: paid }).update({ status: 'refunded', refund_amount: '840.00' });
      const again = await recompute(created.body.run.id);
      expect(commissionOf(again.body.run, 'Sample Alpha')).toBe(0);
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

    it('never counts cash or Zelle a visit\'s prepaid stamp recorded: only the technician attests it', async () => {
      const { cust, est } = await soldWorld();
      const inv = await mintedInvoice(cust, est, { subtotal: '600.00', total: '600.00' });
      const v = await visit(cust, est);
      // admin-schedule.js POST /:id/prepaid, then completion: the payment row it writes has no processor behind it.
      await payment(cust, null, '2026-09-16', '600.00', {
        description: `Invoice WPC-T0 — cash (prepaid at visit)`,
        metadata: JSON.stringify({ invoice_id: inv, scheduled_service_id: v, source: 'scheduled_service_prepaid', method: 'cash', note: null }),
      });
      // The office records a check on the same invoice (record-payment, admin only): that one counts.
      await payment(cust, inv, '2026-09-17', '100.00', { description: 'Invoice WPC-T0 — check' });
      expect(commissionOf((await draft(W1)).body.run, 'Sample Alpha')).toBe(1000);
      expect(await entries()).toHaveLength(1);
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
      // The disputed and the refunded payment are written at 0 with their refund, so no later sync takes them for new money.
      expect((await entries()).map((e) => [Number(e.counted_cents), Number(e.refund_counted_cents)]).sort((a, b) => a[0] - b[0]))
        .toEqual([[0, 10000], [0, 10000], [10000, 0]]);
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

    it('lets a customer merge move a sale to the account that survives, and its revert move it back', async () => {
      const { tech, cust, est } = await soldWorld();
      const inv = await mintedInvoice(cust, est, { subtotal: '600.00', total: '600.00' });
      await payment(cust, inv, '2026-09-16', '600.00');
      await draft(W1);
      const [sale] = await sales();
      const survivor = await customer('Pat', 'Merged');
      const attempt = (fn) => trx.transaction(fn).then(() => null, (err) => err);
      // customer-dedupe.js executeMerge repoints every customer_id column; its revert repoints the same rows back.
      const repoint = (from, to) => attempt(async (inner) => {
        for (const table of ['commission_sales', 'estimates', 'invoices', 'payments']) {
          await inner(table).where({ customer_id: from }).update({ customer_id: to });
        }
      });
      expect(await repoint(cust, survivor)).toBeNull();
      expect((await sales())[0]).toMatchObject({ id: sale.id, customer_id: survivor, technician_id: tech, estimate_id: est });
      // The ledger follows the sale to the survivor: no payment is lost or counted twice.
      const [run] = await trx('payroll_runs').select('id');
      expect(commissionOf((await recompute(run.id)).body.run, 'Sample Alpha')).toBe(6000);
      expect(await entries()).toHaveLength(1);
      expect(await repoint(survivor, cust)).toBeNull();
      expect((await sales())[0].customer_id).toBe(cust);
      // Only the customer may move: a change of any other column with it is still refused.
      expect((await attempt((inner) => inner('commission_sales').where({ id: sale.id })
        .update({ customer_id: survivor, technician_id: tech, accepted_on: '2026-08-11' })))?.message)
        .toMatch(/cannot be changed or deleted/);
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
    // Accepted 2025-01-10: the 12 months ended 2026-01-09, long before the tests' today (2026-10-15).
    const OLD_ACCEPTED = '2025-01-10T15:00:00Z';
    const oldSale = async (tech, cust) => {
      const inv = await soldAgain(cust, tech, OLD_ACCEPTED);
      return payment(cust, inv, '2025-02-03', '1000.00', { updated_at: '2025-02-03T15:00:00Z' });
    };
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

    it('takes a refund recorded inside the 12 months, and seen inside them, off the next commission', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, W1);
      await approvedWeek(tech, W2);
      const cust = await customer();
      const paid = await payment(cust, await soldAgain(cust, tech, ACCEPTED), '2026-09-16', '1000.00');
      const run1 = await draft(W1);
      expect(commissionOf(run1.body.run, 'Sample Alpha')).toBe(10000);
      expect((await finalize(run1.body.run.id)).status).toBe(200);
      await refund(paid, '400.00');
      await payment(cust, await soldAgain(cust, tech, '2026-09-14T15:00:00Z', '500.00'), '2026-09-23', '500.00');
      const run2 = await draft(W2);
      expect(commissionOf(run2.body.run, 'Sample Alpha')).toBe(1000);
      expect(await entryOf(paid)).toEqual([60000, 6000]);
    });

    it('never takes back a refund first seen after the 12 months, though the record says it last changed inside them', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, W1);
      await approvedWeek(tech, W2);
      const cust = await customer();
      const oldPayment = await oldSale(tech, cust);
      const run1 = await draft(W1);
      expect(commissionOf(run1.body.run, 'Sample Alpha')).toBe(10000);
      expect((await finalize(run1.body.run.id)).status).toBe(200);

      // Refund writers do not all stamp updated_at, so the record cannot date the refund: 2026-01-09 is the last day.
      await refund(oldPayment, '400.00', { updated_at: '2026-01-09T15:00:00Z' });
      await payment(cust, await soldAgain(cust, tech, '2026-09-14T15:00:00Z', '500.00'), '2026-09-23', '500.00');
      const run2 = await draft(W2);
      expect(commissionOf(run2.body.run, 'Sample Alpha')).toBe(5000);
      expect(await entryOf(oldPayment)).toEqual([100000, 10000]);
    });

    it('does not take back a refund on a record that changed after the 12 months, first seen after them', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, W1);
      await approvedWeek(tech, W2);
      const cust = await customer();
      const oldPayment = await oldSale(tech, cust);
      const run1 = await draft(W1);
      expect((await finalize(run1.body.run.id)).status).toBe(200);

      // The record changed 2026-01-10, the day after the 12 months.
      await refund(oldPayment, '400.00', { updated_at: '2026-01-10T15:00:00Z' });
      await payment(cust, await soldAgain(cust, tech, '2026-09-14T15:00:00Z', '500.00'), '2026-09-23', '500.00');
      const run2 = await draft(W2);
      expect(commissionOf(run2.body.run, 'Sample Alpha')).toBe(5000);
      expect(await entryOf(oldPayment)).toEqual([100000, 10000]);
    });

    it('counts a payment first seen after the 12 months net of what is refunded then: nothing was paid to take back', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, W1);
      const cust = await customer();
      const oldPayment = await oldSale(tech, cust);
      await refund(oldPayment, '1000.00', { updated_at: '2026-03-01T15:00:00Z' });
      const run1 = await draft(W1);
      expect(commissionOf(run1.body.run, 'Sample Alpha')).toBe(0);
      expect(await entryOf(oldPayment)).toEqual([0, 0]);
    });

    it('never pays a payment refunded in full when first seen inside the 12 months, in any later sync', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, W1);
      await approvedWeek(tech, W2);
      const cust = await customer();
      const paid = await payment(cust, await soldAgain(cust, tech, ACCEPTED), '2026-09-16', '1000.00');
      await refund(paid, '1000.00');
      const run1 = await draft(W1);
      expect(commissionOf(run1.body.run, 'Sample Alpha')).toBe(0);
      expect((await finalize(run1.body.run.id)).status).toBe(200);
      // A later sync after the 12 months (the tests' today moved past 2027-08-09) still reads the stored refund.
      nowSpy.mockReturnValue(Date.parse('2027-09-01T16:00:00Z'));
      const run2 = await draft(W2);
      expect(commissionOf(run2.body.run, 'Sample Alpha')).toBe(0);
      expect(await entryOf(paid)).toEqual([0, 0]);
    });

    it('counts a payment again when a dispute that took it off is won', async () => {
      const { cust, est } = await soldWorld();
      const paid = await payment(cust, await mintedInvoice(cust, est, { subtotal: '1000.00' }), '2026-09-16', '1000.00');
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(10000);
      await trx('payments').where({ id: paid }).update({ status: 'disputed' });
      const lost = await recompute(created.body.run.id);
      expect(commissionOf(lost.body.run, 'Sample Alpha')).toBe(0);
      expect(await entryOf(paid)).toEqual([0, 0]);
      await trx('payments').where({ id: paid }).update({ status: 'paid' });
      const won = await recompute(created.body.run.id);
      expect(commissionOf(won.body.run, 'Sample Alpha')).toBe(10000);
      expect(await entryOf(paid)).toEqual([100000, 10000]);
      const [entry] = await entries();
      expect(Number(entry.refund_counted_cents)).toBe(0);
    });

    it('counts a disputed payment as 0, and counts it again when the dispute is won', async () => {
      const { cust, est } = await soldWorld();
      const disputed = await payment(cust, await mintedInvoice(cust, est, { subtotal: '1000.00' }), '2026-09-16', '1000.00', { status: 'disputed' });
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(0);
      expect((await entries()).map((e) => [Number(e.counted_cents), Number(e.refund_counted_cents)])).toEqual([[0, 100000]]);
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

    it('gives a discount that names a line that is gone no line, as the invoice writer does', async () => {
      const { cust, inv } = await hostInvoice(() => [{
        client_id: 'discount_custom_gone', _kind: 'discount', discount_for: 'scheduled_gone_primary',
        description: 'Orphan discount', amount: -72,
      }], { discount_amount: '72.00', total: '768.00' });
      // The add-on stays $240 of the $840 of lines: 2/7 of the $768 collected, $21.94.
      expect(await paidCommission(cust, inv, '768.00')).toBe(2194);
    });

    // Two $100 lines on a host visit invoice: the host service (not sold) and the sold add-on. `extra` are discount lines.
    const twoLines = async (extra, patch, keys = {}) => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, W1);
      const cust = await customer('Dana', 'Sample');
      const est = await estimate(cust, tech);
      const host = await visit(cust, null);
      const [addon] = await trx('scheduled_service_addons').insert({
        scheduled_service_id: host, service_name: 'Sample add-on', area_addon_scope: JSON.stringify({ sourceEstimateId: est }),
      }).returning('id');
      const hostClient = `scheduled_${host}_primary`;
      const inv = await invoice(cust, {
        subtotal: '200.00', scheduled_service_id: host,
        line_items: JSON.stringify([
          { client_id: hostClient, description: 'Host service', amount: 100, ...keys.host },
          { client_id: `scheduled_${host}_addon_${idOf(addon)}`, description: 'Sample add-on', amount: 100, ...keys.addon },
          ...extra(hostClient),
        ]),
        ...patch,
      });
      return { cust, inv };
    };

    it('narrows a scoped discount to the lines that match every scope it names: key AND category', async () => {
      const { cust, inv } = await twoLines(() => [{
        client_id: 'discount_scoped', _kind: 'discount', discount_for: null, document_discount: true, description: 'Host discount',
        document_scope_service_key: 'sample_host_service', document_scope_service_category: 'pest', amount: -50,
        discount_dollars: 50, use_stored_discount: true, stored_discount_source: 'scheduled_service',
      }], { discount_amount: '50.00', total: '150.00' }, {
        host: { service_key: 'sample_host_service', service_category: 'pest' },
        addon: { service_key: 'sample_addon_service', service_category: 'pest' },
      });
      // The add-on shares the category but not the key: it stays $100 of $150, $10 (not $7.50).
      expect(await paidCommission(cust, inv, '150.00')).toBe(1000);
    });

    it('keeps the writer\'s order: a fixed invoice credit comes off before a line percentage', async () => {
      // A $100 invoice credit and 50% off the host line: the writer takes the credit first ($50 off each line), then
      // 50% of the host's $50 left ($25, saved as its frozen dollars with its percentage sort key). The add-on is $50 of $75.
      const { cust, inv } = await twoLines((hostClient) => [
        { client_id: 'discount_credit', _kind: 'discount', discount_for: null, description: 'Invoice credit', amount: -100, stacking_regime: 'compound' },
        {
          client_id: 'discount_host_half', _kind: 'discount', discount_for: hostClient, description: 'Half off', amount: -25, discount_dollars: 25,
          stack_sort_kind: 'percentage', stack_sort_value: 50, stack_sort_cap: null, stacking_regime: 'compound',
        },
      ], { discount_amount: '125.00', total: '75.00' });
      expect(await paidCommission(cust, inv, '75.00')).toBe(500);
    });
  });

  describe('an estimate deposit', () => {
    // A $100 sold service; the $20 deposit paid at acceptance lives in the deposit ledger (estimate_deposits, no payments
    // row) and is credited on the minted invoice after tax, as a prior payment (invoice.js create), so the invoice asks $80.
    const depositWorld = async () => {
      const { tech, cust, est } = await soldWorld();
      await approvedWeek(tech, W2);
      const inv = await mintedInvoice(cust, est, {
        subtotal: '100.00', total: '80.00', created_at: '2026-09-15T15:00:00Z', updated_at: '2026-09-15T15:00:00Z',
        line_items: JSON.stringify([
          { client_id: 'line_sold', description: 'Sample service', amount: 100 },
          { description: 'Deposit credit (paid at acceptance)', quantity: 1, unit_price: -20, amount: -20, category: 'deposit_credit', estimate_id: est },
        ]),
      });
      const [row] = await trx('estimate_deposits').insert({
        estimate_id: est, customer_id: cust, amount: '20.00', card_surcharge: '0.60', credited_amount: '20.00', status: 'credited',
        credited_invoice_id: inv, stripe_payment_intent_id: `pi_sample_${randomUUID()}`,
        received_at: '2026-09-14T15:00:00Z', updated_at: '2026-09-14T15:00:00Z',
      }).returning('id');
      return { cust, est, inv, deposit: idOf(row) };
    };

    it('counts the deposit, never its card surcharge, with the balance payment: $20 + $80 earns $10', async () => {
      const { cust, est, inv } = await depositWorld();
      const paid = await payment(cust, inv, '2026-09-16', '80.00');
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(1000);
      const rows = await entries();
      expect(rows.map((e) => [e.payment_source, e.payment_id, e.invoice_id, Number(e.counted_cents)]).sort())
        .toEqual([['estimate_deposit', est, inv, 2000], ['payment', paid, inv, 8000]]);
      // The application is dated the day its invoice was made.
      expect(dateOnly(rows.find((e) => e.payment_source === 'estimate_deposit').payment_on)).toBe('2026-09-15');
      // A second sync never counts the deposit again.
      expect((await recompute(created.body.run.id)).status).toBe(200);
      expect(await entries()).toHaveLength(2);
    });

    it('takes a refunded or disputed deposit off though its invoice keeps the credit', async () => {
      const { deposit } = await depositWorld();
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(200);
      expect((await finalize(created.body.run.id)).status).toBe(200);
      // A dashboard refund of $5: the deposit ledger records it, the invoice keeps its credit line.
      await trx('estimate_deposits').where({ id: deposit }).update({ refunded_amount: '5.00', updated_at: '2026-09-22T15:00:00Z' });
      expect((await entries()).map((e) => Number(e.counted_cents))).toEqual([2000]);
      const next = await draft(W2);
      expect(next.status).toBe(201);
      expect((await entries()).map((e) => Number(e.counted_cents))).toEqual([1500]);
      // A dispute reverses the rest (estimate-deposits.js handleDepositChargeReversed: refunded in full).
      await trx('estimate_deposits').where({ id: deposit }).update({ status: 'refunded', refunded_amount: '20.00' });
      expect((await recompute(next.body.run.id)).status).toBe(200);
      expect((await entries()).map((e) => Number(e.counted_cents))).toEqual([0]);
      // Never below $0, never from wages: the $2.00 already paid is not taken back when no later commission comes.
      expect(commissionOf((await api('GET', `/runs/${next.body.run.id}`)).body.run, 'Sample Alpha')).toBe(0);
    });

    it('shares a deposit like a payment among every sale on the invoice it paid: $20 + $180 earns $10 each', async () => {
      const alpha = await readyTech('Sample Alpha');
      const beta = await readyTech('Sample Beta');
      await approvedWeek(alpha, W1);
      await approvedWeek(beta, W1);
      const cust = await customer('Dana', 'Sample');
      const plan = await estimate(cust, alpha);
      const addOnSale = await estimate(cust, beta);
      const first = await visit(cust, plan);
      const [addon] = await trx('scheduled_service_addons').insert({
        scheduled_service_id: first, service_name: 'Sample add-on', area_addon_scope: JSON.stringify({ sourceEstimateId: addOnSale }),
      }).returning('id');
      // The plan's $20 deposit is credited after tax on the first visit's invoice, which also bills the other sale's add-on.
      const inv = await invoice(cust, {
        subtotal: '200.00', total: '180.00', scheduled_service_id: first, created_at: '2026-09-15T15:00:00Z',
        line_items: JSON.stringify([
          { client_id: `scheduled_${first}_primary`, description: 'Sample pest control', amount: 100 },
          { client_id: `scheduled_${first}_addon_${idOf(addon)}`, description: 'Sample add-on', amount: 100 },
          { description: 'Deposit credit (paid at acceptance)', quantity: 1, unit_price: -20, amount: -20, category: 'deposit_credit', estimate_id: plan },
        ]),
      });
      await trx('estimate_deposits').insert({
        estimate_id: plan, customer_id: cust, amount: '20.00', credited_amount: '20.00', status: 'credited', credited_invoice_id: inv,
        stripe_payment_intent_id: `pi_sample_${randomUUID()}`, received_at: '2026-09-14T15:00:00Z', updated_at: '2026-09-14T15:00:00Z',
      });
      await payment(cust, inv, '2026-09-16', '180.00');
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(1000);
      expect(commissionOf(created.body.run, 'Sample Beta')).toBe(1000);
      // The deposit is counted once, half for each sale.
      const depositEntries = (await entries()).filter((e) => e.payment_source === 'estimate_deposit');
      expect(depositEntries.map((e) => Number(e.counted_cents))).toEqual([1000, 1000]);
    });

    it('counts each part of a deposit on the invoice it was applied to: $50 + $50 of $100 across two invoices', async () => {
      const alpha = await readyTech('Sample Alpha');
      const beta = await readyTech('Sample Beta');
      await approvedWeek(alpha, W1);
      await approvedWeek(beta, W1);
      const cust = await customer('Dana', 'Sample');
      const plan = await estimate(cust, alpha);
      const addOnSale = await estimate(cust, beta);
      const first = await visit(cust, plan);
      const second = await visit(cust, plan, { scheduled_date: '2026-09-03' });
      const [addon] = await trx('scheduled_service_addons').insert({
        scheduled_service_id: second, service_name: 'Sample add-on', area_addon_scope: JSON.stringify({ sourceEstimateId: addOnSale }),
      }).returning('id');
      const credit = { description: 'Deposit credit (paid at acceptance)', quantity: 1, unit_price: -50, amount: -50, category: 'deposit_credit', estimate_id: plan };
      // The plan's $100 deposit pays $50 of the first visit's $50 invoice, then the other $50 on the second visit's
      // invoice, which also bills the other sale's $50 add-on (consumeDepositCredit applies a deposit in parts).
      await invoice(cust, {
        subtotal: '50.00', total: '0.00', scheduled_service_id: first, created_at: '2026-09-15T15:00:00Z',
        line_items: JSON.stringify([{ client_id: `scheduled_${first}_primary`, description: 'Sample pest control', amount: 50 }, credit]),
      });
      const shared = await invoice(cust, {
        subtotal: '100.00', total: '50.00', scheduled_service_id: second, created_at: '2026-09-15T16:00:00Z',
        line_items: JSON.stringify([
          { client_id: `scheduled_${second}_primary`, description: 'Sample pest control', amount: 50 },
          { client_id: `scheduled_${second}_addon_${idOf(addon)}`, description: 'Sample add-on', amount: 50 },
          credit,
        ]),
      });
      await trx('estimate_deposits').insert({
        estimate_id: plan, customer_id: cust, amount: '100.00', credited_amount: '100.00', status: 'credited', credited_invoice_id: shared,
        stripe_payment_intent_id: `pi_sample_${randomUUID()}`, received_at: '2026-09-14T15:00:00Z', updated_at: '2026-09-14T15:00:00Z',
      });
      await payment(cust, shared, '2026-09-16', '50.00');
      const created = await draft(W1);
      // The plan: $50 + half of $50 + half of the $50 payment = $100, $10. The add-on: $25 + $25 = $50, $5. $150 collected.
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(1000);
      expect(commissionOf(created.body.run, 'Sample Beta')).toBe(500);
    });

    it('waits for a deposit that sits on no invoice of the sale, and counts a pending one never', async () => {
      const { tech, est } = await soldWorld();
      await approvedWeek(tech, W2);
      await trx('estimate_deposits').insert([
        { estimate_id: est, amount: '20.00', status: 'received', stripe_payment_intent_id: `pi_sample_${randomUUID()}`, received_at: '2026-09-14T15:00:00Z' },
        { estimate_id: est, amount: '30.00', status: 'pending', stripe_payment_intent_id: `pi_sample_${randomUUID()}` },
      ]);
      expect(commissionOf((await draft(W1)).body.run, 'Sample Alpha')).toBe(0);
      expect(await entries()).toHaveLength(0);
    });
  });

  describe('a payer statement', () => {
    // A NET-terms payer statement: settleStatementPaid writes ONE payments row for it (customer_id NULL, statement_id
    // set) and marks its child invoices paid. Returns the statement id and a way to put an invoice on it.
    const statementWorld = async () => {
      const [payer] = await trx('payers').insert({ display_name: 'Sample Property Group', payment_terms: 'net30' }).returning('id');
      const [statement] = await trx('payer_statements').insert({
        payer_id: idOf(payer), period_start: '2026-09-01', period_end: '2026-09-30', status: 'paid', terms_snapshot: 'net30',
        token: randomUUID().replace(/-/g, ''), total: '400.00', subtotal: '400.00', invoice_count: 3,
      }).returning('id');
      const statementId = idOf(statement);
      const child = (customerId, visitId, amount, patch = {}) => invoice(customerId, {
        subtotal: amount, total: amount, status: 'paid', scheduled_service_id: visitId, payer_statement_id: statementId, ...patch,
      });
      const settle = (amount, patch = {}) => trx('payments').insert({
        customer_id: null, payer_id: idOf(payer), statement_id: statementId, payment_date: '2026-09-16', amount, status: 'paid',
        base_amount_cents: Math.round(Number(amount) * 100), description: `Payer statement S-${statementId} settlement (ach)`,
        metadata: JSON.stringify({ statement_id: statementId, payer_id: idOf(payer), payment_method: 'ach', source: 'test' }),
        ...patch,
      }).returning('id').then(([row]) => idOf(row));
      return { statementId, child, settle };
    };

    it('pays each sold invoice its part of the statement payment, and nothing for another home\'s invoice', async () => {
      const { tech, cust, est } = await soldWorld();
      const { child, settle } = await statementWorld();
      const first = await child(cust, await visit(cust, est), '100.00');
      const second = await child(cust, await visit(cust, est, { scheduled_date: '2026-09-03' }), '100.00');
      const neighbor = await customer('Lee', 'Sample');
      await child(neighbor, await visit(neighbor, null), '200.00');
      const paid = await settle('400.00');

      const created = await draft(W1);
      expect(created.status).toBe(201);
      // $100 + $100 of the $400 statement payment: $200 counts, $20 commission.
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(2000);
      const rows = await trx('commission_entries').orderBy('invoice_id');
      expect(rows.map((e) => [e.payment_id, e.invoice_id, e.technician_id])).toEqual(
        [[paid, first, tech], [paid, second, tech]].sort((a, b) => (a[1] < b[1] ? -1 : 1)),
      );
      expect(rows.map((e) => [e.statement_part_cents, e.statement_total_cents, e.counted_cents].map(Number)))
        .toEqual([[10000, 40000, 10000], [10000, 40000, 10000]]);
      // A second sync never adds the same payment and invoice again.
      expect((await recompute(created.body.run.id)).status).toBe(200);
      expect(await entries()).toHaveLength(2);
    });

    it('counts only the settlement row of a statement, never a webhook marker written before it', async () => {
      const { cust, est } = await soldWorld();
      const { statementId, child, settle } = await statementWorld();
      await child(cust, await visit(cust, est), '400.00');
      // stripe-webhook.js writes these on a statement before a validated settlement: no money was collected on them.
      await settle('400.00', { status: 'disputed', base_amount_cents: null, description: `Payer statement S-${statementId} disputed charge (pre-settlement)` });
      await settle('400.00', { status: 'disputed', base_amount_cents: null, description: `Payer statement S-${statementId} dispute won before settlement (marker)` });
      await settle('400.00', { status: 'refunded', base_amount_cents: null, refund_amount: '400.00', description: `Payer statement S-${statementId} fully refunded` });
      // First seen after the 12 months (2027-08-09), when a refund seen later is never taken back.
      nowSpy.mockReturnValue(Date.parse('2027-09-01T16:00:00Z'));
      expect(commissionOf((await draft(W1)).body.run, 'Sample Alpha')).toBe(0);
      expect(await entries()).toHaveLength(0);
      // The office's offline reconcile settles it (settleStatementPaid with no base amount): that row counts.
      await settle('400.00', { base_amount_cents: null, description: `Payer statement S-${statementId} settlement (check)` });
      const [run] = await trx('payroll_runs').select('id');
      expect(commissionOf((await recompute(run.id)).body.run, 'Sample Alpha')).toBe(4000);
    });

    it('spreads the statement payment over the invoices that are not void, and follows a refund of it', async () => {
      const { cust, est } = await soldWorld();
      const { child, settle } = await statementWorld();
      await child(cust, await visit(cust, est), '100.00');
      const neighbor = await customer('Lee', 'Sample');
      await child(neighbor, await visit(neighbor, null), '300.00');
      await child(neighbor, await visit(neighbor, null), '50.00', { status: 'void' });
      const paid = await settle('400.00');
      const created = await draft(W1);
      expect(commissionOf(created.body.run, 'Sample Alpha')).toBe(1000);
      // A quarter of the statement payment is refunded: each invoice loses its part of the refund.
      await trx('payments').where({ id: paid }).update({ refund_amount: '100.00', refund_status: 'partial' });
      expect(commissionOf((await recompute(created.body.run.id)).body.run, 'Sample Alpha')).toBe(750);
      expect(Number((await entries())[0].refund_counted_cents)).toBe(10000);
    });
  });

  describe('a statement refund after the 12 months', () => {
    it('is never taken back, though the statement refund writer leaves updated_at alone', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, W1);
      await approvedWeek(tech, W2);
      const cust = await customer();
      // Accepted 2025-01-10: the 12 months ended 2026-01-09, before the tests' today (2026-10-15).
      const est = await estimate(cust, tech, { accepted_at: '2025-01-10T15:00:00Z' });
      const [payer] = await trx('payers').insert({ display_name: 'Sample Property Group', payment_terms: 'net30' }).returning('id');
      const [statement] = await trx('payer_statements').insert({
        payer_id: idOf(payer), period_start: '2025-01-01', period_end: '2025-01-31', status: 'paid', terms_snapshot: 'net30',
        token: randomUUID().replace(/-/g, ''), total: '400.00', subtotal: '400.00', invoice_count: 1,
      }).returning('id');
      await invoice(cust, {
        subtotal: '400.00', total: '400.00', status: 'paid', payer_statement_id: idOf(statement),
        scheduled_service_id: await visit(cust, est, { scheduled_date: '2025-01-20' }),
      });
      const [settled] = await trx('payments').insert({
        customer_id: null, payer_id: idOf(payer), statement_id: idOf(statement), payment_date: '2025-02-03', amount: '400.00',
        status: 'paid', base_amount_cents: 40000, description: `Payer statement S-${idOf(statement)} settlement (ach)`,
        updated_at: '2025-02-03T15:00:00Z',
      }).returning('id');
      const paid = idOf(settled);
      const run1 = await draft(W1);
      expect(commissionOf(run1.body.run, 'Sample Alpha')).toBe(4000);
      expect((await finalize(run1.body.run.id)).status).toBe(200);
      // stripe-webhook.js charge.refunded on a statement payment: the refund fields change, updated_at does not.
      await trx('payments').where({ id: paid }).update({ status: 'refunded', refund_amount: '400.00', refund_status: 'full' });
      const next = await estimate(cust, tech, { accepted_at: '2026-09-14T15:00:00Z' });
      await payment(cust, await mintedInvoice(cust, next, { subtotal: '500.00' }), '2026-09-23', '500.00');
      const run2 = await draft(W2);
      // The new $50 is paid whole: nothing of the refund is taken back after the 12 months.
      expect(commissionOf(run2.body.run, 'Sample Alpha')).toBe(5000);
      expect((await trx('commission_entries').where({ payment_id: paid })).map((e) => Number(e.counted_cents))).toEqual([40000]);
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
      // (All events share one transaction time, so find the gate-off one rather than take the last.)
      expect(events.find((e) => e.metadata.ledger === 'off').metadata).toMatchObject({ ledger: 'off', removed_count: 1 });
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
