const mockCustomerRows = {};
const mockAuditCalls = [];
const mockRefundFn = jest.fn(async () => ({ refunded: true }));
const mockCancelSignupFn = jest.fn(async () => ({ cancelled: true }));

function makeDbChain(table) {
  let whereCond = {};
  const q = {
    where: jest.fn((a, b) => {
      if (typeof a === 'object' && a) whereCond = { ...whereCond, ...a };
      else if (typeof a === 'string' && b !== undefined) whereCond[a] = b;
      return q;
    }),
    whereNull: jest.fn(() => q),
    forShare: jest.fn(() => q),
    update: jest.fn(() => q),
    returning: jest.fn(async () => (table === 'retention_outreach' || table === 'upsell_opportunities' ? [] : [])),
    first: jest.fn(async () => mockCustomerRows[table] ?? null),
  };
  return q;
}

const mockDb = jest.fn((table) => makeDbChain(table));
mockDb.transaction = jest.fn(async (fn) => fn(Object.assign((t) => makeDbChain(t), { raw: jest.fn(), fn: { now: () => 'NOW' } })));
mockDb.raw = jest.fn((sql) => sql);
mockDb.fn = { now: () => 'NOW' };

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; req.technicianId = 'admin-1'; next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/audit-log', () => ({
  recordAuditEvent: jest.fn(async (ev) => { mockAuditCalls.push(ev); return 1; }),
}));
jest.mock('../services/stripe', () => ({ refund: (...a) => mockRefundFn(...a) }));
jest.mock('../services/customer-offboarding', () => ({ cancelSignupAndRefundDeposit: (...a) => mockCancelSignupFn(...a) }));

const express = require('express');
const fs = require('fs');
const path = require('path');

describe('PR 7 core C360 & Billing Rule 22 hardening', () => {
  let server;
  let baseUrl;
  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin/customers/intelligence', require('../routes/admin-customer-intel'));
    app.use('/api/admin/customers', require('../routes/admin-customers'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
  });
  afterAll((done) => { server.close(done); });
  beforeEach(() => {
    mockAuditCalls.length = 0;
    mockRefundFn.mockReset().mockResolvedValue({ refunded: true });
    mockCancelSignupFn.mockReset().mockResolvedValue({ cancelled: true });
    delete mockCustomerRows.payments;
  });

  test('open-balance OPEN_SELF_PAY_SQL excludes payer-billed, statement-billed, and withdrawn invoices in admin-customers.js', () => {
    const { OPEN_SELF_PAY_SQL } = require('../services/open-balance');
    expect(OPEN_SELF_PAY_SQL).toContain('invoices.payer_id IS NULL');
    expect(OPEN_SELF_PAY_SQL).toContain('invoices.payer_statement_id IS NULL');
    expect(OPEN_SELF_PAY_SQL).toContain("NOT LIKE 'payer_billed:%'");
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-customers.js'), 'utf8');
    expect(src).toContain('applyOpenSelfPayPredicates');
    expect(src).toContain('OPEN_SELF_PAY_SQL');
  });

  test('POST /:id/refund rejects over-refund against remaining refundable amount and audits only after Stripe refund succeeds', async () => {
    mockCustomerRows.payments = { id: 'pay-1', customer_id: 'cust-1', amount: '100.00', refund_amount: '60.00' };
    const over = await fetch(`${baseUrl}/api/admin/customers/cust-1/refund`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paymentId: 'pay-1', amount: '50.00' }),
    });
    expect(over.status).toBe(400);
    expect(mockRefundFn).not.toHaveBeenCalled();
    expect(mockAuditCalls).toHaveLength(0);

    mockRefundFn.mockRejectedValueOnce(new Error('stripe unavailable'));
    const fail = await fetch(`${baseUrl}/api/admin/customers/cust-1/refund`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paymentId: 'pay-1', amount: '25.00' }),
    });
    expect(fail.status).toBe(500);
    expect(mockAuditCalls).toHaveLength(0);

    const ok = await fetch(`${baseUrl}/api/admin/customers/cust-1/refund`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paymentId: 'pay-1', amount: '40.00' }),
    });
    expect(ok.status).toBe(200);
    expect(mockAuditCalls).toHaveLength(1);
    expect(mockAuditCalls[0].action).toBe('customer.payment.refund');
  });

  test('POST /:id/cancel-signup does not write audit event if cancellation throws', async () => {
    mockCancelSignupFn.mockRejectedValueOnce(new Error('offboard failed'));
    const fail = await fetch(`${baseUrl}/api/admin/customers/cust-1/cancel-signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'moved' }),
    });
    expect(fail.status).toBe(500);
    expect(mockAuditCalls).toHaveLength(0);

    const ok = await fetch(`${baseUrl}/api/admin/customers/cust-1/cancel-signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'moved' }),
    });
    expect(ok.status).toBe(200);
    expect(mockAuditCalls).toHaveLength(1);
    expect(mockAuditCalls[0].action).toBe('customer.cancel_signup');
  });

  test('admin-customer-intel validates payloads and returns 404 when row is absent', async () => {
    const badOutcome = await fetch(`${baseUrl}/api/admin/customers/intelligence/retention/ret-1/outcome`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'bogus_status', revenueSaved: -5 }),
    });
    expect(badOutcome.status).toBe(400);

    const missingOutcome = await fetch(`${baseUrl}/api/admin/customers/intelligence/retention/ret-1/outcome`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'retained', revenueSaved: 100 }),
    });
    expect(missingOutcome.status).toBe(404);

    const badUpsell = await fetch(`${baseUrl}/api/admin/customers/intelligence/upsells/up-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'bogus_upsell' }),
    });
    expect(badUpsell.status).toBe(400);

    const missingUpsell = await fetch(`${baseUrl}/api/admin/customers/intelligence/upsells/up-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'pitched' }),
    });
    expect(missingUpsell.status).toBe(404);
  });
});
