/**
 * /admin/invoices/payment-notices — the park queue for Zelle notices the
 * reconciler could not settle (GATE_ZELLE_NOTICE_RECONCILE lane). Pins:
 *   - the static paths win over /:id (Express order) and are admin-only
 *     (listed in NAMED_INVOICE_GETS, so the single-invoice staff exemption
 *     never applies);
 *   - apply re-validates the invoice server-side (a stored candidate or an
 *     exact-amount open self-pay invoice), settles through recordManualPayment
 *     with the Zelle tender + receipt email/SMS, then CAS-closes the notice;
 *   - refusals from the settlement path keep their status codes;
 *   - ignore is a CAS: parked → ignored, 409 otherwise, 404 when missing.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'NOW()') };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; req.technician = { name: 'Adam' }; return next(); },
  requireAdmin: jest.fn((_req, _res, next) => next()),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/invoice-manual-payment', () => ({
  VALID_PAYMENT_METHODS: ['cash', 'check', 'zelle', 'venmo', 'paypal', 'other'],
  recordManualPayment: jest.fn(async (id) => ({ invoice: { id, invoice_number: 'WPC-2026-0500', customer_id: 'cust-1', status: 'paid' }, receipt: { email: { ok: true }, sms: { ok: true } } })),
  retireOpenPaymentIntentBeforeSettlement: jest.fn(async () => null),
}));
jest.mock('../services/open-balance', () => ({
  openSelfPayInvoicesByAmountDue: jest.fn(async () => []),
  rowIsSelfPayDue: jest.fn(async () => true),
}));

const express = require('express');
const db = require('../models/db');
const { requireAdmin } = require('../middleware/admin-auth');
const { recordManualPayment } = require('../services/invoice-manual-payment');
const OpenBalance = require('../services/open-balance');
const router = require('../routes/admin-invoices');

let tables;
function builder(table) {
  const t = tables[table] || (tables[table] = { firsts: [], selects: [], updates: [], calls: [] });
  const b = {};
  ['where', 'whereIn', 'orderBy', 'limit'].forEach((m) => { b[m] = jest.fn((...a) => { t.calls.push([m, ...a]); return b; }); });
  b.first = jest.fn(async () => (t.firsts.length ? t.firsts.shift() : null));
  b.select = jest.fn(async () => (t.selects.length ? t.selects.shift() : []));
  b.update = jest.fn(async (patch) => { t.calls.push(['update', patch]); return t.updates.length ? t.updates.shift() : 1; });
  return b;
}
async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/invoices', router);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/admin/invoices`;
  const call = (method, p, body) => fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  try { await fn(call); } finally { await new Promise((r) => server.close(r)); }
}
const parked = (over = {}) => ({
  id: 'notice-1', email_id: 'email-1', status: 'parked', park_reason: 'name_mismatch', payer_name: 'Pat Doe', amount_cents: 11700,
  memo: 'Quarterly Service Pat D', candidates: [{ invoice_id: 'inv-1', invoice_number: 'WPC-2026-0500', exact_amount: true, name_match: false }], ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  tables = {};
  db.mockImplementation((table) => {
    if (['inbound_payment_notices', 'emails'].includes(table)) return builder(table);
    throw new Error(`unexpected table ${table}`);
  });
});

describe('GET /payment-notices', () => {
  test('is served by the static route (not swallowed by /:id), admin-only, parked by default', async () => {
    tables.inbound_payment_notices = { firsts: [], selects: [[parked()]], updates: [], calls: [] };
    await withServer(async (call) => {
      const r = await call('GET', '/payment-notices');
      expect(r.status).toBe(200);
      expect(r.body.notices).toEqual([expect.objectContaining({ id: 'notice-1', status: 'parked' })]);
    });
    expect(requireAdmin).toHaveBeenCalled();
    expect(tables.inbound_payment_notices.calls).toContainEqual(['where', { status: 'parked' }]);
  });

  test('?status=all lifts the parked filter', async () => {
    tables.inbound_payment_notices = { firsts: [], selects: [[]], updates: [], calls: [] };
    await withServer(async (call) => { expect((await call('GET', '/payment-notices?status=all')).status).toBe(200); });
    expect(tables.inbound_payment_notices.calls.some(([m, a]) => m === 'where' && a && a.status)).toBe(false);
  });
});

describe('POST /payment-notices/:id/apply', () => {
  test('a stored candidate settles through recordManualPayment (Zelle, receipt email + SMS) and closes the notice', async () => {
    tables.inbound_payment_notices = { firsts: [parked()], selects: [], updates: [1], calls: [] };
    await withServer(async (call) => {
      const r = await call('POST', '/payment-notices/notice-1/apply', { invoiceId: 'inv-1' });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, invoice: expect.objectContaining({ id: 'inv-1' }), receipt: { email: { ok: true }, sms: { ok: true } } });
    });
    expect(recordManualPayment).toHaveBeenCalledWith('inv-1', {
      method: 'zelle', reference: 'Pat Doe', note: 'Zelle memo: Quarterly Service Pat D', recordedBy: 'Adam', sendReceipt: true, via: 'both',
    });
    const cas = tables.inbound_payment_notices.calls.find(([m]) => m === 'update');
    expect(cas[1]).toMatchObject({ status: 'applied', match_method: 'manual', matched_invoice_id: 'inv-1', matched_customer_id: 'cust-1', applied_by: 'Adam' });
    expect(tables.inbound_payment_notices.calls).toContainEqual(['where', { id: 'notice-1', status: 'parked' }]);
    expect(tables.emails.calls.find(([m]) => m === 'update')[1]).toMatchObject({ auto_action: 'zelle_notice_applied:WPC-2026-0500' });
  });

  test('an invoice that is neither a candidate nor an exact-amount open invoice is refused before any settlement', async () => {
    tables.inbound_payment_notices = { firsts: [parked()], selects: [], updates: [], calls: [] };
    await withServer(async (call) => {
      const r = await call('POST', '/payment-notices/notice-1/apply', { invoiceId: 'inv-other' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/not a candidate/);
    });
    expect(OpenBalance.openSelfPayInvoicesByAmountDue).toHaveBeenCalledWith(11700);
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('an exact-amount open self-pay invoice outside the stored list is accepted after the server re-check', async () => {
    tables.inbound_payment_notices = { firsts: [parked({ candidates: [] })], selects: [], updates: [1], calls: [] };
    OpenBalance.openSelfPayInvoicesByAmountDue.mockResolvedValueOnce([{ id: 'inv-late', invoice_number: 'WPC-2026-0777' }]);
    await withServer(async (call) => {
      expect((await call('POST', '/payment-notices/notice-1/apply', { invoiceId: 'inv-late' })).status).toBe(200);
    });
    expect(recordManualPayment).toHaveBeenCalledWith('inv-late', expect.objectContaining({ method: 'zelle' }));
  });

  test('missing invoiceId → 400; unknown notice → 404; not parked → 409', async () => {
    tables.inbound_payment_notices = { firsts: [null, parked({ status: 'applied' })], selects: [], updates: [], calls: [] };
    await withServer(async (call) => {
      expect((await call('POST', '/payment-notices/notice-1/apply', {})).status).toBe(400);
      expect((await call('POST', '/payment-notices/nope/apply', { invoiceId: 'inv-1' })).status).toBe(404);
      const r = await call('POST', '/payment-notices/notice-1/apply', { invoiceId: 'inv-1' });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ error: 'Payment notice is applied, not parked', status: 'applied' });
    });
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('a settlement refusal keeps its status code and the notice stays parked', async () => {
    tables.inbound_payment_notices = { firsts: [parked()], selects: [], updates: [], calls: [] };
    recordManualPayment.mockRejectedValueOnce(Object.assign(new Error('Invoice status changed before payment could be recorded'), { statusCode: 409, currentStatus: 'paid' }));
    await withServer(async (call) => {
      const r = await call('POST', '/payment-notices/notice-1/apply', { invoiceId: 'inv-1' });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ error: 'Invoice status changed before payment could be recorded', current_status: 'paid' });
    });
    expect(tables.inbound_payment_notices.calls.some(([m]) => m === 'update')).toBe(false);
  });
});

describe('POST /payment-notices/:id/ignore', () => {
  test('parked → ignored; a non-parked notice is a 409; unknown is a 404', async () => {
    tables.inbound_payment_notices = { firsts: [{ status: 'applied' }, null], selects: [], updates: [1, 0, 0], calls: [] };
    await withServer(async (call) => {
      expect((await call('POST', '/payment-notices/notice-1/ignore')).body).toEqual({ ok: true });
      const r = await call('POST', '/payment-notices/notice-1/ignore');
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ error: 'Payment notice is applied, not parked', status: 'applied' });
      expect((await call('POST', '/payment-notices/nope/ignore')).status).toBe(404);
    });
    expect(tables.inbound_payment_notices.calls[0]).toEqual(['where', { id: 'notice-1', status: 'parked' }]);
  });
});
