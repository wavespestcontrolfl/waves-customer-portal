/**
 * Card on file at the visit for a technician (GATE_TECH_CARD_ON_FILE, owner
 * 2026-11-04, technician visibility audit D4 A).
 *
 * Off: POST /:id/charge-card and /:id/charge-card-quote stay admin only (the
 * router's requireAdmin refuses a technician before any lookup). On: a
 * technician may quote and charge a saved card only for an invoice bound to
 * its own visit scheduled today (ET), On Site or completed; anything else
 * answers 404 before Stripe. The technician charge never overrides a
 * collections hold or a stopped collection, needs the quoted total, and asks
 * the charge to judge the visit again under its own lock. An admin's charge
 * is unchanged. GET /:id tells the payment sheet whether to show the tender.
 *
 * Real router and real technician-visit-scope; mocked db, auth and Stripe.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockRows = {};
const mockAuth = { techRole: 'technician', technicianId: 'tech-1' };

function mockMakeBuilder(table) {
  const b = { table };
  const chain = () => b;
  ['where', 'whereNot', 'whereIn', 'whereNotIn', 'whereNotNull', 'whereNull', 'whereRaw', 'orderBy',
    'limit', 'select', 'leftJoin', 'join', 'andWhere', 'orWhere', 'groupBy', 'forUpdate', 'count']
    .forEach((m) => { b[m] = jest.fn(chain); });
  b.first = jest.fn(() => Promise.resolve(mockRows[table]));
  b.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  b.catch = (fn) => Promise.resolve([]).catch(fn);
  return b;
}
jest.mock('../models/db', () => {
  const fn = jest.fn((table) => mockMakeBuilder(table));
  fn.raw = jest.fn((s) => s);
  fn.transaction = jest.fn(async (cb) => cb(fn));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = mockAuth.technicianId;
    req.techRole = mockAuth.techRole;
    return next();
  },
  // Real semantics (server/middleware/admin-auth.js requireAdmin).
  requireAdmin: (req, res, next) => (req.techRole !== 'admin'
    ? res.status(403).json({ error: 'Admin access required' })
    : next()),
  requireTechOrAdmin: (req, res, next) => (['admin', 'technician'].includes(req.techRole)
    ? next()
    : res.status(403).json({ error: 'Staff access required' })),
}));
jest.mock('../services/stripe', () => ({
  chargeInvoiceWithSavedCard: jest.fn(async () => ({ paymentIntentId: 'pi_test_1' })),
  quoteInvoiceSavedCardCharge: jest.fn(async () => ({ base: 100, surcharge: 2.9, total: 102.9 })),
}));
jest.mock('../services/invoice', () => ({ getById: jest.fn() }));

const express = require('express');
const StripeService = require('../services/stripe');
const InvoiceService = require('../services/invoice');
const { etDateString, addETDays } = require('../utils/datetime-et');
const router = require('../routes/admin-invoices');

const INVOICE_ID = '7c1d2e3f-0000-4a6b-9c3d-00000000a001';
const VISIT_ID = '7c1d2e3f-0000-4a6b-9c3d-00000000b001';
const invoiceRow = (fields = {}) => ({ id: INVOICE_ID, customer_id: 'cust-1', scheduled_service_id: VISIT_ID, ...fields });
const visitRow = (fields = {}) => ({
  id: VISIT_ID, customer_id: 'cust-1', technician_id: 'tech-1', status: 'on_site', scheduled_date: etDateString(), ...fields,
});

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/invoices', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

const post = (baseUrl, path, body) => fetch(`${baseUrl}/api/admin/invoices/${INVOICE_ID}/${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('admin-invoices: a technician\'s card on file at the visit', () => {
  const savedGate = process.env.GATE_TECH_CARD_ON_FILE;

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(mockRows)) delete mockRows[key];
    mockRows.invoices = invoiceRow();
    mockRows.scheduled_services = visitRow();
    mockRows.payment_methods = { method_type: 'card' };
    Object.assign(mockAuth, { techRole: 'technician', technicianId: 'tech-1' });
    process.env.GATE_TECH_CARD_ON_FILE = 'true';
  });
  afterAll(() => {
    if (savedGate === undefined) delete process.env.GATE_TECH_CARD_ON_FILE;
    else process.env.GATE_TECH_CARD_ON_FILE = savedGate;
  });

  test('gate off: a technician gets 403 on both routes and Stripe is never asked', async () => {
    delete process.env.GATE_TECH_CARD_ON_FILE;
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, 'charge-card-quote', { paymentMethodId: 'pm-1' })).status).toBe(403);
      expect((await post(baseUrl, 'charge-card', { paymentMethodId: 'pm-1', expectedTotal: 102.9 })).status).toBe(403);
    });
    expect(StripeService.quoteInvoiceSavedCardCharge).not.toHaveBeenCalled();
    expect(StripeService.chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('gate on, its own visit today and On Site: the quote answers and the charge carries the technician guards', async () => {
    await withServer(async (baseUrl) => {
      const quote = await post(baseUrl, 'charge-card-quote', { paymentMethodId: 'pm-1' });
      expect(quote.status).toBe(200);
      const charge = await post(baseUrl, 'charge-card', { paymentMethodId: 'pm-1', expectedTotal: 102.9 });
      expect(charge.status).toBe(200);
    });
    expect(StripeService.quoteInvoiceSavedCardCharge).toHaveBeenCalledWith(INVOICE_ID, 'pm-1');
    expect(StripeService.chargeInvoiceWithSavedCard).toHaveBeenCalledWith(INVOICE_ID, 'pm-1', {
      expectedTotal: 102.9,
      refuseWhenDunningStopped: true,
      requireSelfPayScheduledServiceId: VISIT_ID,
      requireInvoiceScheduledServiceBinding: true,
      requireTechnicianCardOnFileFor: { techRole: 'technician', technicianId: 'tech-1' },
      requireCardMethod: true,
    });
  });

  // Card only at the visit: a saved bank account, under any of its aliases, never reaches Stripe for a technician.
  test.each(['ach', 'us_bank_account', 'bank', 'bank_account', null])(
    'gate on, a saved method of type %s: both routes answer 400 before Stripe',
    async (methodType) => {
      mockRows.payment_methods = { method_type: methodType };
      await withServer(async (baseUrl) => {
        const quote = await post(baseUrl, 'charge-card-quote', { paymentMethodId: 'pm-bank' });
        expect(quote.status).toBe(400);
        await expect(quote.json()).resolves.toEqual({ error: 'Card on file at the visit takes a saved card, not a bank account.' });
        expect((await post(baseUrl, 'charge-card', { paymentMethodId: 'pm-bank', expectedTotal: 102.9 })).status).toBe(400);
      });
      expect(StripeService.quoteInvoiceSavedCardCharge).not.toHaveBeenCalled();
      expect(StripeService.chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    },
  );

  test('gate on, a method of another customer is not a card the technician may use', async () => {
    delete mockRows.payment_methods;
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, 'charge-card', { paymentMethodId: 'pm-other', expectedTotal: 102.9 })).status).toBe(400);
    });
    expect(StripeService.chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('gate on, a completed visit today still qualifies', async () => {
    mockRows.scheduled_services = visitRow({ status: 'completed' });
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, 'charge-card', { paymentMethodId: 'pm-1', expectedTotal: 102.9 })).status).toBe(200);
    });
    expect(StripeService.chargeInvoiceWithSavedCard).toHaveBeenCalled();
  });

  test.each([
    ['another technician\'s visit', () => { mockRows.scheduled_services = visitRow({ technician_id: 'tech-2' }); }],
    ['its visit yesterday', () => { mockRows.scheduled_services = visitRow({ scheduled_date: etDateString(addETDays(new Date(), -1)) }); }],
    ['its visit today, not yet On Site', () => { mockRows.scheduled_services = visitRow({ status: 'confirmed' }); }],
    ['an invoice bound to no visit', () => { mockRows.invoices = invoiceRow({ scheduled_service_id: null }); }],
    ['a visit of another customer', () => { mockRows.scheduled_services = visitRow({ customer_id: 'cust-2' }); }],
    ['an invoice that does not exist', () => { delete mockRows.invoices; }],
  ])('gate on, %s: both routes answer 404 before Stripe', async (_label, arrange) => {
    arrange();
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, 'charge-card-quote', { paymentMethodId: 'pm-1' })).status).toBe(404);
      expect((await post(baseUrl, 'charge-card', { paymentMethodId: 'pm-1', expectedTotal: 102.9 })).status).toBe(404);
    });
    expect(StripeService.quoteInvoiceSavedCardCharge).not.toHaveBeenCalled();
    expect(StripeService.chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('gate on: a technician charge without the quoted total is refused', async () => {
    await withServer(async (baseUrl) => {
      const r = await post(baseUrl, 'charge-card', { paymentMethodId: 'pm-1' });
      expect(r.status).toBe(400);
      await expect(r.json()).resolves.toEqual({ error: 'expectedTotal required' });
    });
    expect(StripeService.chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('gate on: an admin charge is unchanged (operator override, no visit pin)', async () => {
    Object.assign(mockAuth, { techRole: 'admin', technicianId: 'admin-1' });
    mockRows.scheduled_services = visitRow({ technician_id: 'tech-2', status: 'confirmed' });
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, 'charge-card', { paymentMethodId: 'pm-1', expectedTotal: 102.9 })).status).toBe(200);
    });
    const opts = StripeService.chargeInvoiceWithSavedCard.mock.calls[0][2];
    expect(opts).toMatchObject({ expectedTotal: 102.9, operatorOverride: true });
    expect(opts).not.toHaveProperty('requireTechnicianCardOnFileFor');
    expect(opts).not.toHaveProperty('requireCardMethod');
    expect(opts).not.toHaveProperty('refuseWhenDunningStopped');
  });

  describe('GET /:id tells the payment sheet whether to show Card on File', () => {
    beforeEach(() => {
      InvoiceService.getById.mockImplementation(async () => ({ ...invoiceRow(), total: 102.9, line_items: [] }));
    });
    const read = async () => withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/admin/invoices/${INVOICE_ID}`);
      return { status: r.status, body: await r.json() };
    });

    test('a technician on its own visit today, gate on: tech_card_on_file is true', async () => {
      const { status, body } = await read();
      expect(status).toBe(200);
      expect(body.tech_card_on_file).toBe(true);
    });

    test('gate off, or a visit not On Site: tech_card_on_file is false', async () => {
      delete process.env.GATE_TECH_CARD_ON_FILE;
      expect((await read()).body.tech_card_on_file).toBe(false);
      process.env.GATE_TECH_CARD_ON_FILE = 'true';
      mockRows.scheduled_services = visitRow({ status: 'en_route' });
      expect((await read()).body.tech_card_on_file).toBe(false);
    });

    test('an admin read carries no tech_card_on_file field', async () => {
      Object.assign(mockAuth, { techRole: 'admin', technicianId: 'admin-1' });
      const { status, body } = await read();
      expect(status).toBe(200);
      expect(body).not.toHaveProperty('tech_card_on_file');
    });
  });
});
