/**
 * /admin/invoices/payment-notices — the park queue for Zelle notices the
 * reconciler could not settle (GATE_ZELLE_NOTICE_RECONCILE lane). Pins:
 *   - the static paths win over /:id (Express order) and are admin-only
 *     (listed in NAMED_INVOICE_GETS, so the single-invoice staff exemption
 *     never applies);
 *   - apply re-validates the invoice LIVE (exact cents, open self-pay, payer
 *     re-resolved — the stored candidate list never authorizes), claims the
 *     notice (parked → processing) BEFORE settling, settles through
 *     recordManualPayment with the Zelle tender + receipt email/SMS, then
 *     closes it (processing → applied); a settlement failure hands it back
 *     to the queue as apply_failed;
 *   - refusals from the settlement path keep their status codes;
 *   - ignore is a CAS: parked → ignored, 409 otherwise, 404 when missing.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'NOW()') };
  // Claim + settle + close run under a row lock; the trx reuses the per-table
  // recorder (forUpdate reads come from `locks`).
  fn.transaction = jest.fn(async (work) => { const trx = (table) => fn(table); trx.fn = fn.fn; return work(trx); });
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
  b.forUpdate = jest.fn(() => { t.calls.push(['forUpdate']); b.locked = true; return b; });
  b.first = jest.fn(async () => {
    if (b.locked) return t.locks && t.locks.length ? t.locks.shift() : { id: 'notice-1', status: 'processing' };
    return t.firsts.length ? t.firsts.shift() : null;
  });
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
    if (['inbound_payment_notices', 'emails', 'invoices'].includes(table)) return builder(table);
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
  const liveExact = () => OpenBalance.openSelfPayInvoicesByAmountDue.mockResolvedValueOnce([{ id: 'inv-1', invoice_number: 'WPC-2026-0500', customer_id: 'cust-1', total: '117.00', credit_applied: 0 }]);

  test('a live exact-cent invoice: claim COMMITTED with the invoice + recorder, then lock the row, settle via recordManualPayment (Zelle, receipt email + SMS) and close in one transaction', async () => {
    tables.inbound_payment_notices = { firsts: [parked()], selects: [], updates: [], calls: [] };
    liveExact();
    await withServer(async (call) => {
      const r = await call('POST', '/payment-notices/notice-1/apply', { invoiceId: 'inv-1' });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, invoice: expect.objectContaining({ id: 'inv-1' }), receipt: { email: { ok: true }, sms: { ok: true } } });
    });
    expect(OpenBalance.openSelfPayInvoicesByAmountDue).toHaveBeenCalledWith(11700);
    expect(OpenBalance.rowIsSelfPayDue).toHaveBeenCalledWith('cust-1', expect.objectContaining({ id: 'inv-1' }));
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const calls = tables.inbound_payment_notices.calls;
    const updates = calls.filter(([m]) => m === 'update').map(([, p]) => p);
    // The claim is the FIRST update and precedes the lock (it commits on its own).
    expect(calls.map(([m]) => m).indexOf('update')).toBeLessThan(calls.map(([m]) => m).indexOf('forUpdate'));
    expect(calls[calls.findIndex(([m]) => m === 'update') - 1]).toEqual(['where', { id: 'notice-1', status: 'parked' }]);
    expect(updates[0]).toMatchObject({ status: 'processing', matched_invoice_id: 'inv-1', matched_customer_id: 'cust-1', applied_by: 'Adam' });
    expect(updates[1]).toMatchObject({ status: 'applied', match_method: 'manual', matched_invoice_id: 'inv-1', matched_customer_id: 'cust-1', applied_by: 'Adam' });
    expect(recordManualPayment).toHaveBeenCalledWith('inv-1', {
      method: 'zelle', reference: 'Pat Doe', note: 'Zelle memo: Quarterly Service Pat D', recordedBy: 'Adam', sendReceipt: true, via: 'both', expectedAmountCents: 11700, requireSelfPay: true,
    });
    expect(tables.emails.calls.find(([m]) => m === 'update')[1]).toMatchObject({ auto_action: 'zelle_notice_applied:WPC-2026-0500' });
  });

  test('a stored candidate is NOT enough — the live exact-cent check decides (a ±$5 lead or a since-paid invoice is refused before any claim)', async () => {
    tables.inbound_payment_notices = { firsts: [parked()], selects: [], updates: [], calls: [] };
    OpenBalance.openSelfPayInvoicesByAmountDue.mockResolvedValueOnce([]); // inv-1 no longer open at 11700
    await withServer(async (call) => {
      const r = await call('POST', '/payment-notices/notice-1/apply', { invoiceId: 'inv-1' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/exactly this amount due/);
    });
    expect(recordManualPayment).not.toHaveBeenCalled();
    expect(tables.inbound_payment_notices.calls.some(([m]) => m === 'update')).toBe(false);
  });

  test('a payer re-resolution drop refuses too', async () => {
    tables.inbound_payment_notices = { firsts: [parked()], selects: [], updates: [], calls: [] };
    liveExact();
    OpenBalance.rowIsSelfPayDue.mockResolvedValueOnce(false);
    await withServer(async (call) => { expect((await call('POST', '/payment-notices/notice-1/apply', { invoiceId: 'inv-1' })).status).toBe(400); });
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('a row no longer parked at claim time (a concurrent Apply or Ignore won) → 409, nothing settled', async () => {
    tables.inbound_payment_notices = { firsts: [parked(), { status: 'ignored' }], selects: [], updates: [0], calls: [] };
    liveExact();
    await withServer(async (call) => {
      const r = await call('POST', '/payment-notices/notice-1/apply', { invoiceId: 'inv-1' });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ error: 'Payment notice is ignored, not parked', status: 'ignored' });
    });
    expect(recordManualPayment).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('the DB refusing the claim (another notice already holds this invoice — partial UNIQUE index) → 409, nothing settled', async () => {
    tables.inbound_payment_notices = { firsts: [parked()], selects: [], updates: [], calls: [] };
    liveExact();
    const orig = db.getMockImplementation();
    db.mockImplementation((table) => {
      const b = orig(table);
      if (table === 'inbound_payment_notices') b.update = jest.fn(async () => { throw Object.assign(new Error('duplicate key'), { code: '23505' }); });
      return b;
    });
    await withServer(async (call) => {
      const r = await call('POST', '/payment-notices/notice-1/apply', { invoiceId: 'inv-1' });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ error: 'Another payment notice is already settling this invoice' });
    });
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('a claim that is no longer processing under the lock (the stale sweep parked it) → 409, nothing settled', async () => {
    tables.inbound_payment_notices = { firsts: [parked()], selects: [], updates: [], calls: [], locks: [{ id: 'notice-1', status: 'parked' }] };
    liveExact();
    await withServer(async (call) => {
      const r = await call('POST', '/payment-notices/notice-1/apply', { invoiceId: 'inv-1' });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ error: 'Payment notice is parked, not processing', status: 'parked' });
    });
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('missing invoiceId → 400; unknown notice → 404; not parked → 409; no amount → 400', async () => {
    tables.inbound_payment_notices = { firsts: [null, parked({ status: 'applied' }), parked({ amount_cents: null })], selects: [], updates: [], calls: [] };
    await withServer(async (call) => {
      expect((await call('POST', '/payment-notices/notice-1/apply', {})).status).toBe(400);
      expect((await call('POST', '/payment-notices/nope/apply', { invoiceId: 'inv-1' })).status).toBe(404);
      const r = await call('POST', '/payment-notices/notice-1/apply', { invoiceId: 'inv-1' });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ error: 'Payment notice is applied, not parked', status: 'applied' });
      expect((await call('POST', '/payment-notices/notice-1/apply', { invoiceId: 'inv-1' })).status).toBe(400);
    });
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  test('a settlement refusal keeps its status code and hands the notice back to the queue as apply_failed', async () => {
    tables.inbound_payment_notices = { firsts: [parked()], selects: [], updates: [], calls: [] };
    liveExact();
    recordManualPayment.mockRejectedValueOnce(Object.assign(new Error('Invoice status changed before payment could be recorded'), { statusCode: 409, currentStatus: 'paid' }));
    await withServer(async (call) => {
      const r = await call('POST', '/payment-notices/notice-1/apply', { invoiceId: 'inv-1' });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ error: 'Invoice status changed before payment could be recorded', current_status: 'paid' });
    });
    const updates = tables.inbound_payment_notices.calls.filter(([m]) => m === 'update').map(([, p]) => p);
    expect(updates[0]).toMatchObject({ status: 'processing' });
    expect(updates[1]).toMatchObject({ status: 'parked', park_reason: 'apply_failed', apply_error: 'Invoice status changed before payment could be recorded', matched_invoice_id: null, applied_by: null });
  });
});

describe('POST /payment-notices/:id/apply — post-commit failure', () => {
  test('a non-refusal error after the ledger committed closes the notice as applied (receipt unknown) and returns 200', async () => {
    tables.inbound_payment_notices = { firsts: [parked()], selects: [], updates: [], calls: [] };
    tables.invoices = { firsts: [{ id: 'inv-1', invoice_number: 'WPC-2026-0500', customer_id: 'cust-1', status: 'paid', payment_method: 'zelle', payment_recorded_by: 'Adam', payment_reference: 'Pat Doe' }], selects: [], updates: [], calls: [] };
    OpenBalance.openSelfPayInvoicesByAmountDue.mockResolvedValueOnce([{ id: 'inv-1', invoice_number: 'WPC-2026-0500', customer_id: 'cust-1', total: '117.00', credit_applied: 0 }]);
    recordManualPayment.mockRejectedValueOnce(new Error('receipt stamp exploded'));
    await withServer(async (call) => {
      const r = await call('POST', '/payment-notices/notice-1/apply', { invoiceId: 'inv-1' });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, invoice: expect.objectContaining({ id: 'inv-1', status: 'paid' }), receipt: null });
    });
    const updates = tables.inbound_payment_notices.calls.filter(([m]) => m === 'update').map(([, p]) => p);
    expect(updates[1]).toMatchObject({ status: 'applied', matched_invoice_id: 'inv-1' });
  });
});

describe('POST /payment-notices/:id/apply — post-commit failure, not ours', () => {
  test('a paid invoice under the same recorder but a different tender / reference is NOT this settlement — parks apply_failed (uncertain), 500 surfaces', async () => {
    tables.inbound_payment_notices = { firsts: [parked()], selects: [], updates: [], calls: [] };
    tables.invoices = { firsts: [{ id: 'inv-1', status: 'paid', payment_method: 'check', payment_recorded_by: 'Adam', payment_reference: 'Pat Doe' }], selects: [], updates: [], calls: [] };
    OpenBalance.openSelfPayInvoicesByAmountDue.mockResolvedValueOnce([{ id: 'inv-1', invoice_number: 'WPC-2026-0500', customer_id: 'cust-1', total: '117.00', credit_applied: 0 }]);
    recordManualPayment.mockRejectedValueOnce(new Error('db blip'));
    await withServer(async (call) => {
      const r = await call('POST', '/payment-notices/notice-1/apply', { invoiceId: 'inv-1' });
      expect(r.status).toBe(500);
    });
    const updates = tables.inbound_payment_notices.calls.filter(([m]) => m === 'update').map(([, p]) => p);
    expect(updates[1]).toMatchObject({ status: 'parked', park_reason: 'apply_failed', matched_invoice_id: null });
    expect(updates[1].apply_error).toMatch(/uncertain/);
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
