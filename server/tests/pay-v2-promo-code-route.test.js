/**
 * POST /api/pay/:token/promo-code (GATE_PAY_PROMO_CODE): the public-route
 * guards. A dark gate, a malformed token and an unknown invoice answer the
 * 404 an unknown token gets; the route saves a code under the invoice row
 * lock, refuses one on an invoice that must save a payment method first, and
 * never touches Stripe. What a code is worth, and its redemption at the
 * payment setup, are covered in estimate-promo-code-postgres.test.js and
 * stripe-invoice-payment-intent.test.js.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: {}, isEnabled: jest.fn(() => false) }));
const mockPromo = {
  enterPromoCodeOnInvoice: jest.fn(), promoCodeViewForInvoice: jest.fn(), pendingPromoCredit: jest.fn(),
  promoCodeVerdictAfterSetup: jest.fn(),
};
jest.mock('../services/invoice-promo-code', () => mockPromo);
// Only what /setup reads on its way to the mint; the entry route calls none of it.
const mockStripe = { assertNoInvoiceChargeReconciliationPending: jest.fn(), createInvoicePaymentIntent: jest.fn() };
jest.mock('../services/stripe', () => mockStripe);
jest.mock('../services/estimate-deposits', () => ({ assertInvoiceDepositSettlementReady: jest.fn(async () => {}) }));
// The rows each table answers: the invoice, and the customer the saved-method rule reads.
const mockRows = { invoices: null, customers: null };
jest.mock('../models/db', () => {
  const fn = jest.fn((table) => {
    const q = {};
    for (const m of ['where', 'forUpdate']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => mockRows[table] || null);
    return q;
  });
  // The entry transaction re-reads the invoice under its row lock on the same mock.
  fn.transaction = jest.fn((work) => work(fn));
  return fn;
});

const express = require('express');
const crypto = require('crypto');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');

let server;
let base;
let token;
let lastHeaders;
const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (res) => { lastHeaders = res.headers; return { status: res.status, body: await res.json() }; });

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/pay', require('../routes/pay-v2'));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  server.closeAllConnections();
  server.close(() => done());
});

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation((key) => key === 'payPromoCode');
  // A new invoice link per test: the route allows 10 tries an hour per link.
  token = crypto.randomBytes(32).toString('hex');
  mockRows.invoices = { id: 'inv-1', customer_id: 'cust-1', status: 'sent', total: '100.00' };
  mockRows.customers = { billing_mode: null, monthly_rate: null };
});

const NOT_FOUND = { status: 404, body: { error: 'Invoice not found' } };

test('a dark gate and a malformed token answer the generic 404 without a database read', async () => {
  expect(await post('/api/pay/short/promo-code', { code: 'SAVE25' })).toEqual(NOT_FOUND);
  isEnabled.mockReturnValue(false);
  expect(await post(`/api/pay/${token}/promo-code`, { code: 'SAVE25' })).toEqual(NOT_FOUND);
  expect(db).not.toHaveBeenCalled();
  expect(mockPromo.enterPromoCodeOnInvoice).not.toHaveBeenCalled();
});

test('an unknown invoice answers the same 404', async () => {
  mockRows.invoices = null;
  expect(await post(`/api/pay/${token}/promo-code`, { code: 'SAVE25' })).toEqual(NOT_FOUND);
  expect(mockPromo.enterPromoCodeOnInvoice).not.toHaveBeenCalled();
});

test('the code is saved on the transaction that holds the invoice lock, and the answer is relayed with the privacy headers', async () => {
  expect(await post(`/api/pay/${token}/promo-code`, { code: 12345 })).toEqual({ status: 400, body: { error: 'invalid_code' } });
  expect(mockPromo.enterPromoCodeOnInvoice).not.toHaveBeenCalled();

  mockPromo.enterPromoCodeOnInvoice.mockResolvedValueOnce({ ok: false, reason: 'code_already_entered' });
  expect(await post(`/api/pay/${token}/promo-code`, { code: 'SAVE25' })).toEqual({ status: 400, body: { error: 'code_already_entered' } });

  const applied = { code: 'SAVE25', creditAmount: 25, credited: false };
  mockPromo.enterPromoCodeOnInvoice.mockResolvedValueOnce({ ok: true, applied });
  expect(await post(`/api/pay/${token}/promo-code`, { code: 'save25' }))
    .toEqual({ status: 200, body: { success: true, promoCode: { canEnter: false, applied } } });
  expect(mockPromo.enterPromoCodeOnInvoice).toHaveBeenLastCalledWith({ invoice: expect.objectContaining({ id: 'inv-1' }), rawCode: 'save25' }, db);
  expect(db.transaction).toHaveBeenCalled();
  expect(lastHeaders.get('cache-control')).toContain('no-store');
  expect(lastHeaders.get('x-robots-tag')).toContain('noindex');
});

test('the entry route never calls Stripe', async () => {
  mockPromo.enterPromoCodeOnInvoice.mockResolvedValueOnce({ ok: true, applied: { code: 'SAVE25', creditAmount: 25, credited: false } });
  await post(`/api/pay/${token}/promo-code`, { code: 'SAVE25' });
  expect(mockStripe.createInvoicePaymentIntent).not.toHaveBeenCalled();
  expect(mockStripe.assertNoInvoiceChargeReconciliationPending).not.toHaveBeenCalled();
});

test('/setup reports what became of the code: the applied block, null when it was not credited, no key when there is none', async () => {
  mockStripe.createInvoicePaymentIntent.mockResolvedValue({ clientSecret: 'cs', paymentIntentId: 'pi_1', amount: 75, baseAmount: 75 });
  const applied = { code: 'SAVE25', creditAmount: 25, credited: true };

  mockPromo.promoCodeVerdictAfterSetup.mockResolvedValueOnce({ canEnter: false, applied });
  let setup = await post(`/api/pay/${token}/setup`, {});
  expect(setup.status).toBe(200);
  expect(setup.body).toMatchObject({ paymentIntentId: 'pi_1', promoCode: { canEnter: false, applied } });

  mockPromo.promoCodeVerdictAfterSetup.mockResolvedValueOnce(null);
  setup = await post(`/api/pay/${token}/setup`, {});
  expect(setup.body.promoCode).toBeNull();

  mockPromo.promoCodeVerdictAfterSetup.mockResolvedValueOnce(undefined);
  setup = await post(`/api/pay/${token}/setup`, {});
  expect('promoCode' in setup.body).toBe(false);
});

test('an invoice that must save a payment method first takes no code', async () => {
  mockRows.customers = { billing_mode: 'per_application', monthly_rate: null };
  expect(await post(`/api/pay/${token}/promo-code`, { code: 'SAVE25' })).toEqual({ status: 400, body: { error: 'invalid_code' } });
  expect(mockPromo.enterPromoCodeOnInvoice).not.toHaveBeenCalled();
});
