/**
 * POST /admin/invoices/:id/record-payment — the dispatch checkout's Cash / Check sheet marks its body `checkoutTender: true`
 * (GATE_CHECKOUT_TENDER_RECEIPT, owner 2026-11-18). On 11-18 a check taken at the checkout got no receipt: the sheet sends
 * `sendReceipt: false`, and the payment's quiet closeout completed the visit, so the completion screen never opened.
 * Gate on: the marker asks for the receipt (recordManualPayment queues it) and passes checkoutTender, which leaves the visit open.
 * Gate off, no marker, or the Intelligence Bar card: the body stands exactly as before.
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
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/invoice-manual-payment', () => ({
  ...jest.requireActual('../services/invoice-manual-payment'),
  recordManualPayment: jest.fn(async () => ({ invoice: { id: 'inv-1', status: 'paid' }, receipt: null, closeout: null })),
}));

const express = require('express');
const { recordManualPayment } = require('../services/invoice-manual-payment');
const router = require('../routes/admin-invoices');

async function post(body) {
  const app = express();
  app.use(express.json());
  app.use('/admin/invoices', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    return await fetch(`http://127.0.0.1:${server.address().port}/admin/invoices/inv-1/record-payment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const CHECKOUT_BODY = { method: 'check', note: null, reference: null, sendReceipt: false, checkoutTender: true };

describe('record-payment from the dispatch checkout (GATE_CHECKOUT_TENDER_RECEIPT)', () => {
  const saved = process.env.GATE_CHECKOUT_TENDER_RECEIPT;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_CHECKOUT_TENDER_RECEIPT; else process.env.GATE_CHECKOUT_TENDER_RECEIPT = saved;
    jest.clearAllMocks();
  });

  test('gate on: the checkout sheet asks for the receipt and passes checkoutTender to the settlement', async () => {
    process.env.GATE_CHECKOUT_TENDER_RECEIPT = 'true';
    const res = await post(CHECKOUT_BODY);
    expect(res.status).toBe(200);
    expect(recordManualPayment).toHaveBeenCalledWith('inv-1', expect.objectContaining({
      method: 'check', sendReceipt: true, checkoutTender: true, recordedByTechnicianId: 'admin-1',
    }));
  });

  test('gate off (read at call time): the sheet body stands, no receipt and the closeout runs', async () => {
    delete process.env.GATE_CHECKOUT_TENDER_RECEIPT;
    expect((await post(CHECKOUT_BODY)).status).toBe(200);
    process.env.GATE_CHECKOUT_TENDER_RECEIPT = 'TRUE';
    expect((await post({ ...CHECKOUT_BODY, method: 'cash' })).status).toBe(200);
    for (const [, args] of recordManualPayment.mock.calls) {
      expect(args).toEqual(expect.objectContaining({ sendReceipt: false, via: 'both' }));
      expect(args).not.toHaveProperty('checkoutTender');
    }
  });

  test('gate on, any other caller: the Invoices page body (no marker, or a non-boolean one) is unchanged', async () => {
    process.env.GATE_CHECKOUT_TENDER_RECEIPT = 'true';
    await post({ method: 'check', sendReceipt: false });
    await post({ method: 'check', sendReceipt: true, via: 'email' });
    await post({ method: 'check', sendReceipt: false, checkoutTender: 'true' });
    const calls = recordManualPayment.mock.calls.map(([, args]) => [args.sendReceipt, args.via, 'checkoutTender' in args]);
    expect(calls).toEqual([[false, 'both', false], [true, 'email', false], [false, 'both', false]]);
  });
});
