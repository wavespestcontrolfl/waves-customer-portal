/**
 * The Intelligence Bar's record_payment replays the Invoices page's own Record payment handler
 * (admin-invoices.js recordPaymentFromBar). The page route and the shim must reach the same settlement
 * (recordManualPayment) with the same arguments and return the same answers; the card's pins (amount due,
 * invoice version, self-pay) exist only on the shim path, and the page path stays exactly what it was.
 * Nothing here reaches a provider. Synthetic data only.
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
  adminAuthenticate: (req, _res, next) => { req.technician = { name: 'Ava Admin', email: 'ava@example.test' }; req.technicianId = 'admin-1'; next(); },
  requireAdmin: (req, _res, next) => { req.technician = { name: 'Ava Admin', email: 'ava@example.test' }; req.technicianId = 'admin-1'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
// The one settlement path: mocked here (its own suite proves it). The tender list and the PI retire stay real shapes.
jest.mock('../services/invoice-manual-payment', () => ({
  VALID_PAYMENT_METHODS: ['cash', 'check', 'zelle', 'venmo', 'paypal', 'other'],
  recordManualPayment: jest.fn(),
  retireOpenPaymentIntentBeforeSettlement: jest.fn(),
}));

const express = require('express');
const { recordManualPayment } = require('../services/invoice-manual-payment');
const router = require('../routes/admin-invoices');

const INV = '00000000-0000-4000-8000-0000000000a1';
const BODY = { method: 'check', reference: '1042', note: 'left at the front desk', sendReceipt: false };
const PAID = { id: INV, status: 'paid', invoice_number: 'WPC-2099-0001' };

async function viaPage(body) {
  const app = express();
  app.use(express.json());
  app.use('/admin/invoices', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/invoices/${INV}/record-payment`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const FENCES = { refuseHeldReport: true, refuseAnnualTerm: true, approvedReceipt: { email: 'e-digest', phone: 'p-digest' } };
const APPROVED = { expectedAmountCents: 11700, expectedInvoiceVersion: { status: 'sent', updatedAtMs: 4070908800123 }, cardFences: FENCES };
const viaBar = (body = BODY, approvedPayment = APPROVED) => router.recordPaymentFromBar({
  invoiceId: INV, body, actor: { technicianId: 'admin-1', name: 'Ava Admin', email: 'ava@example.test' }, approvedPayment,
});

beforeEach(() => {
  jest.clearAllMocks();
  recordManualPayment.mockResolvedValue({ invoice: PAID, receipt: null });
});

describe('the page path is unchanged', () => {
  test('the settlement gets exactly the page body and no card pin', async () => {
    const res = await viaPage(BODY);
    expect(res).toEqual({ status: 200, json: { ok: true, invoice: PAID, receipt: null } });
    expect(recordManualPayment).toHaveBeenCalledTimes(1);
    const [id, args] = recordManualPayment.mock.calls[0];
    expect(id).toBe(INV);
    expect(args).toEqual({
      method: 'check', reference: '1042', note: 'left at the front desk', recordedBy: 'Ava Admin',
      sendReceipt: false, via: 'both', recordedByTechnicianId: 'admin-1',
    });
    expect(Object.keys(args)).not.toEqual(expect.arrayContaining(['expectedAmountCents']));
    expect(Object.keys(args)).not.toContain('expectedInvoiceVersion');
    expect(Object.keys(args)).not.toContain('requireSelfPay');
    expect(Object.keys(args)).not.toContain('cardFences');
  });

  test('a card pin sent in the HTTP body is ignored: only the bar shim can set it', async () => {
    await viaPage({ ...BODY, ibApprovedPayment: APPROVED, expectedAmountCents: 1, expectedInvoiceVersion: { status: 'x', updatedAtMs: 1 }, requireSelfPay: true });
    const [, args] = recordManualPayment.mock.calls[0];
    expect(args).not.toHaveProperty('expectedAmountCents');
    expect(args).not.toHaveProperty('expectedInvoiceVersion');
    expect(args).not.toHaveProperty('requireSelfPay');
    expect(args).not.toHaveProperty('cardFences');
  });

  test('a lost-race 409 answers as before, with no preview code', async () => {
    const err = Object.assign(new Error('Invoice status changed before payment could be recorded'), { statusCode: 409, currentStatus: 'paid' });
    recordManualPayment.mockRejectedValueOnce(err);
    expect(await viaPage(BODY)).toEqual({ status: 409, json: { error: err.message, current_status: 'paid' } });
  });

  test('an unknown method is the page\'s own 400 and reaches no settlement', async () => {
    const res = await viaPage({ method: 'bitcoin' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('method must be one of: cash, check, zelle, venmo, paypal, other');
    expect(recordManualPayment).not.toHaveBeenCalled();
  });
});

describe('the bar shim runs the same handler', () => {
  test('same settlement, same body, same answer, plus the card pins', async () => {
    const page = await viaPage(BODY);
    const bar = await viaBar();
    expect(bar).toEqual({ status: page.status, json: page.json });
    expect(recordManualPayment).toHaveBeenCalledTimes(2);
    const [pageCall, barCall] = recordManualPayment.mock.calls;
    expect(barCall[0]).toBe(pageCall[0]);
    expect(barCall[1]).toEqual({ ...pageCall[1], ...APPROVED, requireSelfPay: true });
    // The recorder is the staff member's name, as the page path reads it from the login.
    expect(barCall[1].recordedBy).toBe('Ava Admin');
  });

  test('a card pin refusal answers 409 with the PREVIEW_CHANGED code; any other 409 carries none', async () => {
    recordManualPayment.mockRejectedValueOnce(Object.assign(new Error('The invoice changed after the confirmation card was shown — nothing was recorded'), { statusCode: 409, drift: true }));
    expect(await viaBar()).toMatchObject({ status: 409, json: { code: 'PREVIEW_CHANGED' } });
    recordManualPayment.mockRejectedValueOnce(Object.assign(new Error('A payment is already in flight (processing)'), { statusCode: 409 }));
    const other = await viaBar();
    expect(other.status).toBe(409);
    expect(other.json).not.toHaveProperty('code');
  });

  test('an unexpected failure rejects, like next(err) on the page', async () => {
    recordManualPayment.mockRejectedValueOnce(new Error('db down'));
    await expect(viaBar()).rejects.toThrow('db down');
  });
});
