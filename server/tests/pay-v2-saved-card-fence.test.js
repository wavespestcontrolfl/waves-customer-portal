jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: jest.fn(),
  parkInvoiceForSavedCardReconciliation: jest.fn(),
  savedCardChargeSuppressesAlternateCollection: jest.fn(() => true),
  savedCardChargeNeedsReconciliation: jest.fn(),
  createInvoicePaymentIntent: jest.fn(),
  updateInvoicePaymentIntentMethod: jest.fn(),
  quoteInvoiceSurcharge: jest.fn(),
  finalizeInvoicePayment: jest.fn(),
  confirmInvoicePayment: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const StripeService = require('../services/stripe');
const router = require('../routes/pay-v2');

function invoiceQuery(invoice) {
  const query = {};
  query.where = jest.fn(() => query);
  query.first = jest.fn(async () => invoice);
  return query;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/pay', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('POST /api/pay/:token/setup saved-card reconciliation fence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        return invoiceQuery({
          id: 'inv-1',
          token: 'public-token',
          customer_id: 'cust-1',
          status: 'sent',
          total: 100,
          credit_applied: 0,
          payer_statement_id: null,
        });
      }
      if (table === 'customers') {
        return invoiceQuery({ billing_mode: null, monthly_rate: 0 });
      }
      throw new Error(`unexpected table ${table}`);
    });
  });

  test.each([
    ['active claim', 'STRIPE_CHARGE_IN_PROGRESS', false],
    ['ambiguous outcome', 'STRIPE_AMBIGUOUS_OUTCOME', true],
  ])('does not mint a second PaymentIntent during an %s', async (_label, code, reconciliationRequired) => {
    StripeService.assertNoInvoiceChargeReconciliationPending.mockRejectedValue(
      Object.assign(new Error('saved-card collection is fenced'), { code }),
    );
    StripeService.savedCardChargeNeedsReconciliation.mockReturnValue(reconciliationRequired);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/pay/public-token/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual(expect.objectContaining({
        inProgress: false,
        savedCardPending: true,
        reconciliationRequired,
      }));
    });

    expect(StripeService.createInvoicePaymentIntent).not.toHaveBeenCalled();
    if (reconciliationRequired) {
      expect(StripeService.parkInvoiceForSavedCardReconciliation).toHaveBeenCalledWith(expect.objectContaining({
        invoiceId: 'inv-1',
      }));
    } else {
      expect(StripeService.parkInvoiceForSavedCardReconciliation).not.toHaveBeenCalled();
    }
  });

  test.each([
    ['update-amount', { paymentIntentId: 'pi-old', methodCategory: 'card' }, 'updateInvoicePaymentIntentMethod'],
    ['quote', { paymentMethodId: 'pm-old' }, 'quoteInvoiceSurcharge'],
    ['finalize', { quoteToken: 'quote-old' }, 'finalizeInvoicePayment'],
    ['confirm', { paymentIntentId: 'pi-old' }, 'confirmInvoicePayment'],
  ])('fences an existing pay-page intent at /%s', async (route, body, serviceMethod) => {
    StripeService.assertNoInvoiceChargeReconciliationPending.mockRejectedValue(
      Object.assign(new Error('saved-card collection is fenced'), { code: 'STRIPE_CHARGE_IN_PROGRESS' }),
    );
    StripeService.savedCardChargeNeedsReconciliation.mockReturnValue(false);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/pay/public-token/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual(expect.objectContaining({
        inProgress: false,
        savedCardPending: true,
        reconciliationRequired: false,
      }));
    });

    expect(StripeService[serviceMethod]).not.toHaveBeenCalled();
  });

  test('returns the distinct saved-card state when the final serialized check loses', async () => {
    StripeService.assertNoInvoiceChargeReconciliationPending.mockResolvedValue(undefined);
    StripeService.finalizeInvoicePayment.mockRejectedValue(Object.assign(
      new Error('saved-card collection claimed before confirm'),
      {
        code: 'STRIPE_CHARGE_IN_PROGRESS',
        statusCode: 409,
        savedCardPending: true,
        reconciliationRequired: false,
      },
    ));

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/pay/public-token/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteToken: 'quote-token' }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual(expect.objectContaining({
        inProgress: false,
        savedCardPending: true,
        reconciliationRequired: false,
      }));
    });
  });
});
