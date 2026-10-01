/**
 * POST /:id/send-receipt and /batch/send-receipts hold the invoice's
 * receipt-job claim (receipt-delivery-queue's claimReceiptJobForOperatorSend)
 * around both legs: claimed before anything sends, handed back after the
 * receipt_sent_at stamp with the email outcome, and a job the drain is
 * delivering right now refuses the operator send instead of racing it into a
 * second receipt. The claim's own SQL is proven in
 * receipt-operator-claim-postgres.test.js.
 */
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
jest.mock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: jest.fn(async () => null) }));
jest.mock('../services/invoice-email', () => ({ sendReceiptEmail: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/receipt-delivery-queue', () => ({
  claimReceiptJobForOperatorSend: jest.fn(async () => ({ id: 'job-1', token: 'claim-1', prior: { status: 'queued', next_attempt_at: 'T' } })),
  recordOperatorReceiptDelivered: jest.fn(async () => undefined),
  releaseOperatorReceiptClaim: jest.fn(async () => undefined),
}));

const express = require('express');
const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const { sendReceiptEmail } = require('../services/invoice-email');
const { claimReceiptJobForOperatorSend, recordOperatorReceiptDelivered, releaseOperatorReceiptClaim } = require('../services/receipt-delivery-queue');
const { closeOutVisitForIssuedInvoice } = require('../services/invoice-issued-closeout');
const router = require('../routes/admin-invoices');

const INVOICE_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
let invoiceUpdates;

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
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

beforeEach(() => {
  jest.clearAllMocks();
  invoiceUpdates = [];
  jest.spyOn(InvoiceService, 'sendReceipt').mockResolvedValue({ sent: true });
  db.mockImplementation((table) => {
    const q = {};
    ['where', 'whereIn', 'whereNull'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => ({ id: INVOICE_ID, status: 'paid', customer_id: 'cust-1', invoice_number: 'WPC-2026-0900' }));
    q.update = jest.fn(async (patch) => { invoiceUpdates.push({ table, patch }); return 1; });
    q.insert = jest.fn(() => ({ catch: () => Promise.resolve() }));
    return q;
  });
});
afterEach(() => jest.restoreAllMocks());

describe('POST /:id/send-receipt', () => {
  test('claims the receipt job before either leg and releases it after the stamp with the email outcome', async () => {
    const r = await withServer((base) => post(base, `/${INVOICE_ID}/send-receipt`, { via: 'both' }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, email: { ok: true }, sms: { ok: true } });
    // The route read an unstamped invoice: the claim refuses if another path stamps it first.
    expect(claimReceiptJobForOperatorSend).toHaveBeenCalledWith(INVOICE_ID, { sawUnsent: true });
    const claimAt = claimReceiptJobForOperatorSend.mock.invocationCallOrder[0];
    // Claimed before the closeout too: a queued receipt cannot deliver during it.
    expect(claimAt).toBeLessThan(closeOutVisitForIssuedInvoice.mock.invocationCallOrder[0]);
    expect(claimAt).toBeLessThan(sendReceiptEmail.mock.invocationCallOrder[0]);
    expect(claimAt).toBeLessThan(InvoiceService.sendReceipt.mock.invocationCallOrder[0]);
    expect(invoiceUpdates).toContainEqual({ table: 'invoices', patch: expect.objectContaining({ receipt_sent_at: 'now()' }) });
    // Each delivered leg is recorded on the claim the moment it succeeds.
    expect(recordOperatorReceiptDelivered).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'job-1' }), 'email');
    expect(recordOperatorReceiptDelivered.mock.invocationCallOrder[0]).toBeLessThan(InvoiceService.sendReceipt.mock.invocationCallOrder[0]);
    expect(recordOperatorReceiptDelivered).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'job-1' }), 'sms');
    expect(releaseOperatorReceiptClaim).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1' }),
      expect.objectContaining({ emailDelivered: true }),
    );
  });

  test('an SMS-only resend hands the queued job back (emailDelivered false) — it still owes the email', async () => {
    await withServer((base) => post(base, `/${INVOICE_ID}/send-receipt`, { via: 'sms' }));
    expect(sendReceiptEmail).not.toHaveBeenCalled();
    expect(recordOperatorReceiptDelivered).toHaveBeenCalledTimes(1);
    expect(recordOperatorReceiptDelivered).toHaveBeenCalledWith(expect.anything(), 'sms');
    expect(releaseOperatorReceiptClaim).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ emailDelivered: false, smsDelivered: true }));
  });

  test('a leg that throws still releases the claim', async () => {
    db.mockImplementation((table) => {
      const q = {};
      ['where'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.first = jest.fn(async () => ({ id: INVOICE_ID, status: 'paid', customer_id: 'cust-1', invoice_number: 'WPC-2026-0900' }));
      q.update = jest.fn(async () => { throw new Error(`${table} write failed`); });
      return q;
    });
    const r = await withServer((base) => post(base, `/${INVOICE_ID}/send-receipt`, { via: 'email' }));
    expect(r.status).toBe(500);
    expect(releaseOperatorReceiptClaim).toHaveBeenCalledTimes(1);
  });

  test('a receipt job the drain is delivering right now: 409, nothing sent, nothing stamped', async () => {
    claimReceiptJobForOperatorSend.mockResolvedValueOnce({ inFlight: true });
    const r = await withServer((base) => post(base, `/${INVOICE_ID}/send-receipt`, { via: 'both' }));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('receipt_delivery_in_flight');
    expect(closeOutVisitForIssuedInvoice).not.toHaveBeenCalled();
    expect(sendReceiptEmail).not.toHaveBeenCalled();
    expect(InvoiceService.sendReceipt).not.toHaveBeenCalled();
    expect(invoiceUpdates).toEqual([]);
    expect(releaseOperatorReceiptClaim).not.toHaveBeenCalled();
  });
});

test('POST /:id/send-receipt: a stale claim the claim step found already delivered → 409 receipt_already_sent, nothing sent', async () => {
  claimReceiptJobForOperatorSend.mockResolvedValueOnce({ alreadySent: true });
  const r = await withServer((base) => post(base, `/${INVOICE_ID}/send-receipt`, { via: 'both' }));
  expect(r.status).toBe(409);
  expect(r.body.code).toBe('receipt_already_sent');
  expect(sendReceiptEmail).not.toHaveBeenCalled();
  expect(InvoiceService.sendReceipt).not.toHaveBeenCalled();
  expect(releaseOperatorReceiptClaim).not.toHaveBeenCalled();
});

describe('POST /batch/send-receipts', () => {
  test('each invoice is claimed and released around its legs; an in-flight one is skipped and a claim failure fails only that one', async () => {
    const ids = ['a1111111-1111-4111-8111-111111111111', 'a2222222-2222-4222-8222-222222222222', 'a3333333-3333-4333-8333-333333333333'];
    claimReceiptJobForOperatorSend
      .mockResolvedValueOnce({ id: 'job-1', token: 't1', prior: null })
      .mockResolvedValueOnce({ inFlight: true })
      .mockRejectedValueOnce(new Error('db blip'));
    const r = await withServer((base) => post(base, '/batch/send-receipts', { invoiceIds: ids }));
    expect(r.status).toBe(200);
    expect(r.body.sent).toEqual([{ invoiceId: ids[0], channels: { email: true, sms: true } }]);
    expect(r.body.skipped).toEqual([{ invoiceId: ids[1], reason: 'receipt_delivery_in_flight' }]);
    expect(r.body.failed).toEqual([{ invoiceId: ids[2], error: 'receipt claim failed: db blip' }]);
    expect(sendReceiptEmail).toHaveBeenCalledTimes(1);
    expect(closeOutVisitForIssuedInvoice).toHaveBeenCalledTimes(1);
    expect(claimReceiptJobForOperatorSend.mock.invocationCallOrder[0]).toBeLessThan(closeOutVisitForIssuedInvoice.mock.invocationCallOrder[0]);
    expect(releaseOperatorReceiptClaim).toHaveBeenCalledTimes(1);
    expect(releaseOperatorReceiptClaim).toHaveBeenCalledWith({ id: 'job-1', token: 't1', prior: null }, expect.objectContaining({ emailDelivered: true, smsDelivered: true }));
    expect(recordOperatorReceiptDelivered.mock.calls.map(([, leg]) => leg)).toEqual(['email', 'sms']);
  });
});
