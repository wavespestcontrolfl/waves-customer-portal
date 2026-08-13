/**
 * POST /billing-v2/cards — payer-routing fence before Auto Pay enrollment
 * (Codex #3395 r7 P1).
 *
 * The save endpoint used to enroll unconditionally: a customer whose
 * invoices route to a third-party payer (or whose payer picture is
 * unknowable) would have the homeowner's card flipped into Auto Pay,
 * pointing self-pay charging at the wrong party — and no later guard can
 * undo an enrollment that already happened. Contract: payer-billed (or a
 * failed payer check — FAIL CLOSED) keeps the method saved with consent
 * recorded, SKIPS enrollment, parks a billing office exception, and
 * responds success with enrolled:false; self-pay accounts enroll exactly
 * as before.
 */
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.customerId = 'cust-1'; next(); },
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/payment-router', () => ({}));
jest.mock('../config/stripe-config', () => ({}));
jest.mock('../services/payment-lifecycle-email', () => ({}));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/invoice-helpers', () => ({ invoiceAmountDue: jest.fn(() => 0) }));
jest.mock('../services/autopay-eligibility', () => ({
  isBankMethodType: jest.fn(() => false),
  isExpiredCardMethod: jest.fn(() => false),
}));
jest.mock('../services/stripe', () => ({
  retrieveSetupIntent: jest.fn(),
  savePaymentMethod: jest.fn(),
}));
jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn();
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../services/payment-method-consents', () => ({
  recordConsent: jest.fn(async () => ({})),
  hasConsentFor: jest.fn(async () => false),
  hasEnrollmentScopedConsent: jest.fn(async () => false),
}));
jest.mock('../services/autopay-enrollment', () => ({
  enrollConsentedMethod: jest.fn(async () => ({ enrolled: true })),
}));
jest.mock('../services/payer', () => ({
  resolveForInvoice: jest.fn(async () => ({ payerId: null })),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({})),
}));

const express = require('express');
const db = require('../models/db');
const StripeService = require('../services/stripe');
const PayerService = require('../services/payer');
const { enrollConsentedMethod } = require('../services/autopay-enrollment');
const NotificationService = require('../services/notification-service');
const router = require('../routes/billing-v2');

const SAVED_CARD = {
  id: 'pm-row-1', customer_id: 'cust-1', method_type: 'card',
  card_brand: 'visa', last_four: '4242', exp_month: 12, exp_year: 2030,
  is_default: true, stripe_payment_method_id: 'pm_stripe_1',
};

function mkChain(firstResult) {
  const q = {};
  for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'orderBy', 'limit', 'select']) {
    q[m] = () => q;
  }
  q.first = async () => firstResult;
  q.update = async () => 1;
  q.then = (ok, err) => Promise.resolve([]).then(ok, err);
  return q;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/billing', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

const postCard = (baseUrl) => fetch(`${baseUrl}/billing/cards`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ setupIntentId: 'si_1' }),
});

beforeEach(() => {
  jest.clearAllMocks();
  StripeService.retrieveSetupIntent.mockResolvedValue({
    status: 'succeeded',
    payment_method: { id: 'pm_stripe_1', type: 'card' },
  });
  // payment_methods lookups: the saved-card row already exists (idempotent
  // lookup-first save); the current-autopay-method probe finds none.
  let pmCalls = 0;
  db.mockImplementation((table) => {
    if (table === 'payment_methods') {
      pmCalls += 1;
      // First payment_methods read is the current-autopay probe (whereNotNull
      // + first('id')); second is the lookup-first save. Return the saved row
      // for the lookup, nothing for the probe.
      return mkChain(pmCalls === 1 ? undefined : { ...SAVED_CARD });
    }
    return mkChain(undefined);
  });
  PayerService.resolveForInvoice.mockResolvedValue({ payerId: null });
});

describe('POST /cards payer fence', () => {
  test('self-pay accounts enroll exactly as before', async () => {
    await withServer(async (baseUrl) => {
      const res = await postCard(baseUrl);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(enrollConsentedMethod).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1', paymentMethodId: 'pm-row-1',
      }));
    });
  });

  test('a payer-billed account saves the card but NEVER enrolls — office exception parked', async () => {
    PayerService.resolveForInvoice.mockResolvedValue({ payerId: 'payer-1' });
    await withServer(async (baseUrl) => {
      const res = await postCard(baseUrl);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ success: true, enrolled: false, enrollReason: 'payer_billed' });
      expect(body.card.id).toBe('pm-row-1');
      expect(enrollConsentedMethod).not.toHaveBeenCalled();
      expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
        'billing', expect.stringMatching(/payer-billed/), expect.any(String), expect.any(Object),
      );
    });
  });

  test('a failed payer check fails CLOSED: saved, not enrolled, office exception', async () => {
    PayerService.resolveForInvoice.mockRejectedValue(new Error('payer lookup down'));
    await withServer(async (baseUrl) => {
      const res = await postCard(baseUrl);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ success: true, enrolled: false, enrollReason: 'payer_check_failed' });
      expect(enrollConsentedMethod).not.toHaveBeenCalled();
      expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
        'billing', expect.stringMatching(/payer check failed/), expect.any(String), expect.any(Object),
      );
    });
  });
});
