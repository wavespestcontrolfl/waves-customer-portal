/**
 * Tech #2 billing & schedule feed isolation (PR 1B):
 * - P0-2 (billing): GET /api/admin/dispatch/:date? strips monthlyRate, autopay,
 *   estimatedPrice, prepaid*, checkoutInvoice* for technicians
 * - P1-T1: GET /api/admin/customers/:id/cards gated on GATE_TECH_CARD_ON_FILE +
 *   today's owned visit + non-deleted customer + card-only (no ACH bank_name)
 * - P1-T4 (Decision 4): POST /api/admin/schedule/:id/invoice locked to today's
 *   live visit, omits public token, rejects negative/unbounded extraLineItems;
 *   POST/DELETE /:id/prepaid admin-only
 * - P2-T1: GET /api/admin/schedule/recommend-slots & /zone-density admin-only
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

const { etDateString, addETDays } = require('../utils/datetime-et');

describe('P1-T1: GET /api/admin/customers/:id/cards tech isolation', () => {
  const savedGate = process.env.GATE_TECH_CARD_ON_FILE;
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_TECH_CARD_ON_FILE;
    else process.env.GATE_TECH_CARD_ON_FILE = savedGate;
    jest.resetModules();
  });

  function loadApp({ role = 'technician', ownToday = true, methods = [] } = {}) {
    const mockDb = jest.fn((table) => {
      const q = {
        _whereRaw: [],
        join: jest.fn(() => q),
        where: jest.fn(() => q),
        whereNotIn: jest.fn(() => q),
        whereNull: jest.fn(() => q),
        whereRaw: jest.fn((sql) => { q._whereRaw.push(sql); return q; }),
        orderBy: jest.fn(() => q),
        first: jest.fn(async () => (table === 'scheduled_services' && ownToday ? { id: 'svc-1' } : null)),
        then: (resolve) => {
          let rows = table === 'payment_methods' ? methods : [];
          if (table === 'payment_methods' && q._whereRaw.some((s) => /method_type/i.test(s))) {
            rows = rows.filter((m) => String(m.method_type || '').toLowerCase() === 'card');
          }
          return Promise.resolve(rows).then(resolve);
        },
        catch: () => q,
      };
      return q;
    });
    mockDb.fn = { now: () => new Date() };
    mockDb.raw = (s) => s;
    jest.resetModules();
    jest.doMock('../models/db', () => mockDb);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    jest.doMock('../services/payer', () => ({
      resolveForInvoice: jest.fn(async () => ({ payerId: null })),
      scheduledServicesHasSelfPay: jest.fn(async () => true),
    }));
    jest.doMock('../middleware/admin-auth', () => ({
      adminAuthenticate: (req, _res, next) => { req.techRole = role; req.technicianId = 'tech-1'; next(); },
      requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
      requireTechOrAdmin: (_req, _res, next) => next(),
    }));
    const express = require('express');
    const router = require('../routes/admin-customers');
    const app = express();
    app.use('/api/admin/customers', router);
    return app;
  }

  async function run(app, path) {
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  test('gate off: technician gets 403 and zero cards', async () => {
    delete process.env.GATE_TECH_CARD_ON_FILE;
    const { status, body } = await run(loadApp({ role: 'technician', ownToday: true }), '/api/admin/customers/cust-1/cards');
    expect(status).toBe(403);
    expect(body.cards).toBeUndefined();
  });

  test('gate on + no visit today: technician gets 404', async () => {
    process.env.GATE_TECH_CARD_ON_FILE = 'true';
    const { status } = await run(loadApp({ role: 'technician', ownToday: false }), '/api/admin/customers/cust-1/cards');
    expect(status).toBe(404);
  });

  test('gate on + today visit: returns card methods only without bank_name; admin keeps ACH banks', async () => {
    process.env.GATE_TECH_CARD_ON_FILE = 'true';
    const methods = [
      { id: 'pm-card', method_type: 'card', card_brand: 'visa', last_four: '4242', exp_month: 12, exp_year: 2029, bank_name: null, is_default: true },
      { id: 'pm-ach', method_type: 'ach', card_brand: null, last_four: '9876', exp_month: null, exp_year: null, bank_name: 'Chase', is_default: false },
    ];
    const tech = await run(loadApp({ role: 'technician', ownToday: true, methods }), '/api/admin/customers/cust-1/cards');
    expect(tech.status).toBe(200);
    expect(tech.body.cards).toHaveLength(1);
    expect(tech.body.cards[0]).toMatchObject({ id: 'pm-card', method_type: 'card', last_four: '4242' });
    expect(tech.body.cards[0]).not.toHaveProperty('bank_name');

    jest.resetModules();
    const admin = await run(loadApp({ role: 'admin', ownToday: false, methods }), '/api/admin/customers/cust-1/cards');
    expect(admin.status).toBe(200);
    expect(admin.body.cards).toHaveLength(2);
    expect(admin.body.cards[1].bank_name).toBe('Chase');
  });
});

describe('P1-T4 & P2-T1: admin-schedule tech billing & dispatch-admin boundaries', () => {
  afterEach(() => { jest.resetModules(); });

  function loadScheduleApp({ role = 'technician', visits = [], existingInvoice = null } = {}) {
    const normCol = (c) => String(c).replace(/^scheduled_services\./, '');
    const mockDb = jest.fn((table) => {
      const preds = [];
      const q = {
        where(a, op, b) {
          if (a && typeof a === 'object') {
            for (const [k, v] of Object.entries(a)) preds.push((r) => r[normCol(k)] === v);
          } else if (b !== undefined) {
            preds.push((r) => (op === '>=' ? r[normCol(a)] >= b : r[normCol(a)] === b));
          } else {
            preds.push((r) => r[normCol(a)] === op);
          }
          return q;
        },
        andWhere(...args) { return q.where(...args); },
        whereNot(col, val) { preds.push((r) => r[normCol(col)] !== val); return q; },
        whereNotIn(col, list) { preds.push((r) => !list.includes(r[normCol(col)])); return q; },
        whereIn() { return q; },
        whereNull() { return q; },
        modify(cb) { cb(q); return q; },
        leftJoin() { return q; },
        select() { return q; },
        orderBy() { return q; },
        forUpdate() { return q; },
        first: jest.fn(async () => {
          if (table === 'scheduled_services') return visits.find((v) => preds.every((p) => p(v))) || undefined;
          if (table === 'invoices') return existingInvoice || undefined;
          return undefined;
        }),
        then: (resolve) => Promise.resolve([]).then(resolve),
        catch: () => q,
      };
      return q;
    });
    mockDb.fn = { now: () => new Date() };
    mockDb.raw = (s) => s;
    mockDb.transaction = async (cb) => cb(mockDb);
    jest.doMock('../models/db', () => mockDb);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    jest.doMock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
    jest.doMock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => ({ payerId: null })) }));
    jest.doMock('../services/annual-prepay-renewals', () => ({
      ANNUAL_PREPAY_PREPAID_METHOD: 'annual_prepay_invoice',
      pafDeferredPrepayCoversVisit: jest.fn(async () => false),
      annualPrepayCoversVisit: jest.fn(async () => false),
    }));
    jest.doMock('../middleware/admin-auth', () => ({
      adminAuthenticate: (req, _res, next) => { req.techRole = role; req.technicianId = 'tech-1'; next(); },
      requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
      requireTechOrAdmin: (_req, _res, next) => next(),
    }));
    const express = require('express');
    const router = require('../routes/admin-schedule');
    const app = express();
    app.use(express.json());
    app.use('/api/admin/schedule', router);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    return app;
  }

  async function reqJson(app, method, path, body) {
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  test('GET /recommend-slots and GET /zone-density refuse technicians with 403', async () => {
    const app = loadScheduleApp({ role: 'technician' });
    expect((await reqJson(app, 'GET', `/api/admin/schedule/recommend-slots?date=${etDateString()}`)).status).toBe(403);
    expect((await reqJson(app, 'GET', `/api/admin/schedule/zone-density?date=${etDateString()}`)).status).toBe(403);
  });

  test('POST /:id/invoice refuses future-date visit for technician (today only)', async () => {
    const future = etDateString(addETDays(new Date(), 3));
    const app = loadScheduleApp({
      role: 'technician',
      visits: [{ id: 'svc-future', customer_id: 'c1', technician_id: 'tech-1', status: 'confirmed', scheduled_date: future, estimated_price: 120, service_type: 'Pest Control' }],
    });
    const res = await reqJson(app, 'POST', '/api/admin/schedule/svc-future/invoice', {});
    expect(res.status).toBe(404);
  });

  test('POST /:id/invoice omits public token on reuse for technician and rejects custom negative extraLineItems', async () => {
    const today = etDateString();
    const visit = { id: 'svc-today', customer_id: 'c1', technician_id: 'tech-1', status: 'on_site', scheduled_date: today, estimated_price: 120, service_type: 'Pest Control' };
    const reuseApp = loadScheduleApp({
      role: 'technician',
      visits: [visit],
      existingInvoice: { id: 'inv-1', status: 'sent', total: 120, token: 'public-secret-tok', payer_id: null, credit_applied: 0, amount_paid: 0 },
    });
    const reused = await reqJson(reuseApp, 'POST', '/api/admin/schedule/svc-today/invoice', {});
    expect(reused.status).toBe(200);
    expect(reused.body.invoiceId).toBe('inv-1');
    expect(reused.body.token).toBeUndefined();

    jest.resetModules();
    const negApp = loadScheduleApp({ role: 'technician', visits: [visit], existingInvoice: null });
    const neg = await reqJson(negApp, 'POST', '/api/admin/schedule/svc-today/invoice', {
      extraLineItems: [{ description: 'Arbitrary discount', quantity: 1, unit_price: -50, amount: -50 }],
    });
    expect(neg.status).toBe(403);
    expect(neg.body.error).toMatch(/Only admins/i);

    const catalogDiscount = await reqJson(negApp, 'POST', '/api/admin/schedule/svc-today/invoice', {
      extraLineItems: [{ description: 'Free WDO', quantity: 1, unit_price: -120, amount: -120, discount_id: 'disc-wdo-100' }],
    });
    expect(catalogDiscount.status).toBe(403);

    const huge = await reqJson(negApp, 'POST', '/api/admin/schedule/svc-today/invoice', {
      extraLineItems: [{ description: 'Huge line', quantity: 1, unit_price: 9999, amount: 9999 }],
    });
    expect(huge.status).toBe(403);
  });

  test('GET /api/admin/schedule/list omits office billing fields (and future estimatedPrice) for technicians while keeping today estimatedPrice', async () => {
    const today = etDateString();
    const future = etDateString(addETDays(new Date(), 4));
    const visits = [
      {
        id: 'svc-list-today', customer_id: 'c1', technician_id: 'tech-1', status: 'confirmed',
        scheduled_date: today, service_type: 'Pest Control', estimated_price: 155,
        primary_line_price: 155, prepaid_amount: 75, prepaid_method: 'cash', prepaid_at: today,
        payer_id: 'payer-1', po_number: 'PO-999', self_pay_override: true,
        first_name: 'Pat', last_name: 'Example', address: '100 Main St', city: 'Sarasota', zip: '34231',
      },
      {
        id: 'svc-list-future', customer_id: 'c2', technician_id: 'tech-1', status: 'confirmed',
        scheduled_date: future, service_type: 'Pest Control', estimated_price: 210,
        primary_line_price: 210, prepaid_amount: 50, prepaid_method: 'cash', prepaid_at: today,
        payer_id: 'payer-2', po_number: 'PO-888', self_pay_override: false,
        first_name: 'Sam', last_name: 'Future', address: '200 Oak St', city: 'Sarasota', zip: '34231',
      },
    ];
    const mockDb = jest.fn((table) => {
      const q = {
        where: () => q, andWhere: () => q, orWhere: () => q, whereNot: () => q, whereNotIn: () => q,
        whereIn: () => q, whereNull: () => q, whereNotNull: () => q, whereRaw: () => q,
        modify: (cb) => { cb(q); return q; },
        leftJoin: () => q, join: () => q, select: () => q, clearSelect: () => q, clearOrder: () => q,
        orderBy: () => q, orderByRaw: () => q, limit: () => q, offset: () => q, clone: () => q,
        count: () => ({ first: async () => ({ count: '2' }) }),
        columnInfo: async () => ({}),
        first: async () => ({ count: '2' }),
        then: (resolve) => Promise.resolve(table === 'scheduled_services' ? visits : []).then(resolve),
        catch: () => q,
      };
      return q;
    });
    mockDb.fn = { now: () => new Date() };
    mockDb.raw = (s) => s;
    mockDb.schema = { hasColumn: async () => true, hasTable: async () => true };
    jest.resetModules();
    jest.doMock('../models/db', () => mockDb);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    jest.doMock('../services/payer', () => ({
      resolveForInvoice: jest.fn(async () => ({ payerId: null })),
      scheduledServicesHasSelfPay: jest.fn(async () => true),
    }));
    jest.doMock('../middleware/admin-auth', () => ({
      adminAuthenticate: (req, _res, next) => { req.techRole = 'technician'; req.technicianId = 'tech-1'; next(); },
      requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
      requireTechOrAdmin: (_req, _res, next) => next(),
    }));
    const express = require('express');
    const router = require('../routes/admin-schedule');
    const app = express();
    app.use('/api/admin/schedule', router);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    const res = await reqJson(app, 'GET', `/api/admin/schedule/list?from=${today}`);
    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(2);
    const [todayRow, futureRow] = res.body.services;
    expect(todayRow.estimatedPrice).toBe(155);
    expect(futureRow.estimatedPrice).toBeUndefined();
    for (const row of [todayRow, futureRow]) {
      for (const key of ['primaryLinePrice', 'prepaidAmount', 'prepaidMethod', 'prepaidAt', 'payerId', 'poNumber', 'selfPayOverride', 'monthlyRate', 'leadScore']) {
        expect(row[key]).toBeUndefined();
      }
    }
  });

  test('serializeCheckoutInvoiceForFeed preserves checkoutInvoicePrepaidApplied on today technician visits while redacting line items, credits, and amounts paid', () => {
    const { serializeCheckoutInvoiceForFeed } = require('../routes/admin-schedule');
    const today = etDateString();
    const future = etDateString(addETDays(new Date(), 3));
    const invoice = {
      id: 'inv-1',
      status: 'sent',
      total: 160,
      invoice_number: 'INV-100',
      line_items: [{ description: 'Pest Control', amount: 160 }, { description: 'Owner courtesy', amount: -20 }],
      credit_applied: 25,
      amount_paid: 35,
      payer_id: null,
    };
    const techReq = { techRole: 'technician' };
    const todayOut = serializeCheckoutInvoiceForFeed(techReq, { scheduled_date: today }, invoice, true);
    expect(todayOut).toEqual({
      checkoutInvoiceId: 'inv-1',
      checkoutInvoiceStatus: 'sent',
      checkoutInvoiceTotal: 100,
      checkoutInvoiceNumber: 'INV-100',
      checkoutInvoiceLines: [],
      checkoutInvoiceCreditApplied: 0,
      checkoutInvoiceAmountPaid: 0,
      checkoutInvoicePrepaidApplied: true,
      checkoutInvoicePayerBilled: false,
    });

    const futureOut = serializeCheckoutInvoiceForFeed(techReq, { scheduled_date: future }, invoice, true);
    expect(futureOut.checkoutInvoiceId).toBeNull();
    expect(futureOut.checkoutInvoiceTotal).toBeNull();
    expect(futureOut.checkoutInvoicePrepaidApplied).toBe(false);
  });
});
