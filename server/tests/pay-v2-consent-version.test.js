/**
 * Pay page — rendered consent-version attestation (codex #5434 r1 P1).
 *
 * The pay page bundles its own copy of the saved-payment-method consent
 * text, so a tab left open across a copy change keeps rendering the older
 * text. Every save-the-method capture therefore attests the CONSENT_VERSION
 * it rendered: /setup, /update-amount and /finalize refuse a stale or
 * absent attestation BEFORE any Stripe work (409 CONSENT_VERSION_STALE,
 * surfaced as "refresh the page") and thread the version into the mint,
 * which stamps it on the PaymentIntent; /consent records only under a
 * current stamp — never the posting bundle's constant (a redirect return
 * posts from a freshly loaded bundle). A plain one-off payment (no save)
 * attests nothing and is untouched.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({
  assertInvoiceDepositSettlementReady: jest.fn(async () => {}),
  withInvoiceDepositSettlement: jest.fn(async (_id, callback) => callback(require('../models/db'))),
}));
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: jest.fn(),
  parkInvoiceForSavedCardReconciliation: jest.fn(),
  savedCardChargeSuppressesAlternateCollection: jest.fn(() => true),
  savedCardChargeNeedsReconciliation: jest.fn(),
  createInvoicePaymentIntent: jest.fn(async () => ({ clientSecret: 'cs', paymentIntentId: 'pi_1' })),
  savePaymentMethod: jest.fn(async () => ({ id: 'pm-row-1', customer_id: 'cust-1', method_type: 'card' })),
  updateInvoicePaymentIntentMethod: jest.fn(async () => ({ base: 100, surcharge: 0, total: 100 })),
  quoteInvoiceSurcharge: jest.fn(),
  finalizeInvoicePayment: jest.fn(async () => ({ status: 'succeeded' })),
  confirmInvoicePayment: jest.fn(),
  retrievePaymentIntent: jest.fn(),
}));
jest.mock('../services/payment-method-consents', () => ({
  recordConsent: jest.fn(async () => ({ id: 'consent-1', consent_text_version: 'v12_2026-09-30' })),
  hasConsentFor: jest.fn(async () => false),
  linkPaymentMethodId: jest.fn(async () => {}),
}));
jest.mock('../services/visit-completion-packets', () => ({ invoicePayerOwnedNow: jest.fn(async () => false) }));
jest.mock('../services/autopay-enrollment', () => ({ enrollConsentedMethod: jest.fn(async () => ({ enrolled: true })) }));

const express = require('express');
const db = require('../models/db');
const StripeService = require('../services/stripe');
const ConsentService = require('../services/payment-method-consents');
const { CONSENT_VERSION } = require('../services/payment-method-consent-text');
const router = require('../routes/pay-v2');

const TOKEN = 'public-token-0123456789';
const STALE = 'v11_2026-08-25';

function query(result) {
  const q = {};
  q.where = jest.fn(() => q);
  q.forUpdate = jest.fn(() => q);
  q.first = jest.fn(async () => result);
  return q;
}

let invoice;
let requireSave;
beforeEach(() => {
  jest.clearAllMocks();
  requireSave = false;
  invoice = {
    id: 'inv-1', token: TOKEN, customer_id: 'cust-1', status: 'sent', total: 100, credit_applied: 0,
    payer_statement_id: null, payer_id: null, stripe_payment_intent_id: 'pi_1', updated_at: null,
  };
  db.mockImplementation((table) => {
    if (table === 'invoices') return query(invoice);
    // billing_mode per_application makes the invoice a required-save one (invoiceRequiresSavedMethod).
    if (table === 'customers') return query({ billing_mode: requireSave ? 'per_application' : null, monthly_rate: 0 });
    if (table === 'payment_methods') return query(null);
    return query(null);
  });
  db.transaction = jest.fn(async (fn) => fn(db));
});

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/pay', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (baseUrl, route, body) => fetch(`${baseUrl}/api/pay/${TOKEN}/${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('save-the-method mints attest the rendered consent version', () => {
  test.each([
    ['setup', { saveCard: true }, 'createInvoicePaymentIntent'],
    ['update-amount', { paymentIntentId: 'pi_1', methodCategory: 'card', saveCard: true }, 'updateInvoicePaymentIntentMethod'],
    ['finalize', { quoteToken: 'quote-1', saveCard: true }, 'finalizeInvoicePayment'],
  ])('/%s with the current version mints and threads the version to the stamp', async (route, body, method) => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, route, { ...body, consentTextVersion: CONSENT_VERSION });
      expect(res.status).toBe(200);
    });
    expect(StripeService[method]).toHaveBeenCalledTimes(1);
    const opts = StripeService[method].mock.calls[0][StripeService[method].mock.calls[0].length - 1];
    expect(opts).toEqual(expect.objectContaining({ saveCard: true, consentTextVersion: CONSENT_VERSION }));
  });

  test.each([
    ['setup', { saveCard: true }, 'createInvoicePaymentIntent'],
    ['update-amount', { paymentIntentId: 'pi_1', methodCategory: 'card', saveCard: true }, 'updateInvoicePaymentIntentMethod'],
    ['finalize', { quoteToken: 'quote-1', saveCard: true }, 'finalizeInvoicePayment'],
  ])('/%s saving under a STALE version → 409 CONSENT_VERSION_STALE, no Stripe work', async (route, body, method) => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, route, { ...body, consentTextVersion: STALE });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.code).toBe('CONSENT_VERSION_STALE');
      expect(json.error).toMatch(/refresh the page/i);
    });
    expect(StripeService[method]).not.toHaveBeenCalled();
  });

  test('/setup saving with NO attestation (a bundle that predates it) → 409, no mint', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'setup', { saveCard: true });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('CONSENT_VERSION_STALE');
    });
    expect(StripeService.createInvoicePaymentIntent).not.toHaveBeenCalled();
  });

  test('a REQUIRED-save invoice forces the attestation even when the body says saveCard:false', async () => {
    requireSave = true;
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'setup', { saveCard: false });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('CONSENT_VERSION_STALE');
    });
    expect(StripeService.createInvoicePaymentIntent).not.toHaveBeenCalled();
  });

  test('a plain one-off payment (no save) attests nothing and mints as before', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'setup', { saveCard: false });
      expect(res.status).toBe(200);
    });
    expect(StripeService.createInvoicePaymentIntent).toHaveBeenCalledTimes(1);
    expect(StripeService.createInvoicePaymentIntent.mock.calls[0][1]).toEqual(expect.objectContaining({ saveCard: false, consentTextVersion: undefined }));
  });
});

describe('POST /consent records only under the PaymentIntent’s own current stamp', () => {
  const pi = (metadata) => ({
    id: 'pi_1',
    status: 'succeeded',
    setup_future_usage: 'off_session',
    payment_method: 'pm_1',
    payment_method_types: ['card'],
    latest_charge: { payment_method_details: { type: 'card' } },
    metadata: { save_card_opt_in: 'true', waves_customer_id: 'cust-1', ...metadata },
  });

  test('a current stamp (minted by a tab rendering the current text) records the consent', async () => {
    StripeService.retrievePaymentIntent.mockResolvedValue(pi({ consent_text_version: CONSENT_VERSION }));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'consent', { stripePaymentMethodId: 'pm_1', methodCategory: 'card', consentTextVersion: CONSENT_VERSION });
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);
    });
    expect(ConsentService.recordConsent).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', stripePaymentMethodId: 'pm_1', source: 'pay_page' }));
  });

  test.each([
    ['a stale stamp', { consent_text_version: STALE }],
    ['no stamp (minted before stamps existed)', {}],
  ])('%s → 409 CONSENT_VERSION_STALE, nothing recorded — even when the posting bundle is current', async (_name, metadata) => {
    StripeService.retrievePaymentIntent.mockResolvedValue(pi(metadata));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'consent', { stripePaymentMethodId: 'pm_1', methodCategory: 'card', consentTextVersion: CONSENT_VERSION });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('CONSENT_VERSION_STALE');
    });
    expect(ConsentService.recordConsent).not.toHaveBeenCalled();
  });

  test('a PaymentIntent that never opted in is still the benign skip (redirect returns post here unconditionally)', async () => {
    StripeService.retrievePaymentIntent.mockResolvedValue({ ...pi({}), setup_future_usage: null, metadata: { save_card_opt_in: 'false' } });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'consent', { consentTextVersion: CONSENT_VERSION });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: false, skipped: true, reason: 'not_opted_in' });
    });
    expect(ConsentService.recordConsent).not.toHaveBeenCalled();
  });
});
