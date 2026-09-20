// Codex round-6 P2 (#4131 slice 4): when a preclaimed nested sendViaSMS
// call inside sendViaSMSAndEmail resolves deposit_settlement_pending (the
// balance went back to zero-due AFTER the outer claim but BEFORE the
// nested SMS-leg claim), the wrapper used to copy the code only onto
// `sms` — no top-level `code` promoted it, so /:id/send fell through to a
// generic 400 and the batch routes counted it a plain failure instead of
// held. Exercises the REAL sendViaSMSAndEmail/claimInvoiceForSend (only
// the deep provider dispatch — sendViaSMS itself — and its own
// dependencies are mocked away), through the REAL express route, so this
// proves the promotion actually reaches the HTTP response.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'now()') };
  fn.transaction = jest.fn(async (callback) => callback(fn));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/estimate-deposits', () => ({
  assertInvoiceDepositSettlementReady: jest.fn(async () => undefined),
}));
jest.mock('../services/customer-credit', () => ({
  autoApplyAccountCreditIfEnabled: jest.fn(async () => null),
}));
// services/invoice is REAL here — only its own deep provider dispatch
// (sendViaSMS) is spied away below, per test.

const express = require('express');
const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const router = require('../routes/admin-invoices');

const INVOICE_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/invoices', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (baseUrl, path, body) => fetch(`${baseUrl}/admin/invoices${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

// A perfectly ordinary, non-zero-due invoice: the OUTER claim below
// succeeds normally (this finding is about a race INSIDE the nested
// sendViaSMS call, not the outer claim's own zero-due detection).
function claimableRow() {
  return {
    id: INVOICE_ID, status: 'draft', total: 100, credit_applied: 0,
    sent_at: null, sms_sent_at: null, email_sent_at: null, send_claim_token: null,
    scheduled_send_at: null, scheduled_send_error: null, payer_id: null,
    visit_completion_packet_id: null, payer_statement_id: null,
    customer_id: 'cust-1', scheduled_request_review: false, scheduled_review_delay_minutes: null,
  };
}

function makeDb() {
  let row = claimableRow();
  const invoicesQuery = () => {
    const predicates = [];
    const q = {};
    q.where = jest.fn((criteria) => {
      if (criteria && typeof criteria === 'object') {
        predicates.push((r) => Object.entries(criteria).every(([k, v]) => r[k] === v));
      }
      return q;
    });
    q.whereIn = jest.fn(() => q);
    q.whereNull = jest.fn((col) => { predicates.push((r) => r[col] == null); return q; });
    q.whereNotNull = jest.fn((col) => { predicates.push((r) => r[col] != null); return q; });
    q.whereRaw = jest.fn(() => q);
    q.forUpdate = jest.fn(() => q);
    q.first = jest.fn(async () => ({ ...row }));
    q.update = jest.fn((payload) => {
      q.__matched = predicates.every((p) => p(row));
      if (q.__matched) row = { ...row, ...payload };
      return q;
    });
    q.returning = jest.fn(async () => (q.__matched ? [{ ...row }] : []));
    return q;
  };
  const smsLog = {};
  smsLog.whereRaw = jest.fn(() => smsLog);
  smsLog.whereIn = jest.fn(() => smsLog);
  smsLog.where = jest.fn(() => smsLog);
  smsLog.first = jest.fn(async () => null);
  smsLog.update = jest.fn(() => smsLog);
  smsLog.returning = jest.fn(async () => []);
  smsLog.insert = jest.fn(async () => []);
  smsLog.then = (resolve) => resolve([]);
  db.mockImplementation((table) => (table === 'invoices' ? invoicesQuery() : smsLog));
}

// The exact resolved shape the nested sendViaSMS call produces for this
// race (settleZeroDueBeforeSend's chokepoint, mapped by
// zeroDueDirectSendOutcome's 'refused' branch).
const pendingSmsResult = {
  sent: false, ok: false, code: 'deposit_settlement_pending', deliveryOutcome: 'not_sent',
  retryable: true, reason: 'Nothing is due on this invoice, but it could not be settled yet (existing_payment_work) — not sent.',
};

describe('a preclaimed deposit_settlement_pending refusal inside sendViaSMSAndEmail is promoted to the top level (Codex round-6 P2 #4131)', () => {
  let smsSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    makeDb();
    smsSpy = jest.spyOn(InvoiceService, 'sendViaSMS').mockResolvedValue(pendingSmsResult);
  });
  afterEach(() => smsSpy.mockRestore());

  test('POST /:id/send returns 409 with code deposit_settlement_pending, not a generic 400', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${INVOICE_ID}/send`, {});
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body).toMatchObject({ ok: false, code: 'deposit_settlement_pending' });
      expect(body.error).toMatch(/could not be settled yet/);
    });
  });

  test('POST /batch/send files it in the held bucket, not failed', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/batch/send', { invoiceIds: [INVOICE_ID] });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.failed_count).toBe(0);
      expect(body.held_count).toBe(1);
      expect(body.held[0]).toMatchObject({ invoiceId: INVOICE_ID, code: 'deposit_settlement_pending' });
    });
  });
});
