process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'tech-1';
    req.techRole = 'technician';
    return next();
  },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/stripe', () => ({
  chargeInvoiceWithSavedCard: jest.fn(),
  quoteInvoiceSavedCardCharge: jest.fn(),
}));

const express = require('express');
const StripeService = require('../services/stripe');
const router = require('../routes/admin-invoices');

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

describe('POST /:id/charge-card uncertain outcomes', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns the server-authoritative saved-card quote', async () => {
    StripeService.quoteInvoiceSavedCardCharge.mockResolvedValue({
      base: 250,
      surcharge: 7.25,
      total: 257.25,
      rateBps: 290,
      funding: 'credit',
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/invoices/inv-1/charge-card-quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethodId: 'pm-1' }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        quote: expect.objectContaining({ total: 257.25, surcharge: 7.25 }),
      });
      expect(StripeService.quoteInvoiceSavedCardCharge).toHaveBeenCalledWith('inv-1', 'pm-1');
    });
  });

  test('passes the quoted total into the authoritative charge comparison', async () => {
    StripeService.chargeInvoiceWithSavedCard.mockResolvedValue({ id: 'pay-1' });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/invoices/inv-1/charge-card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethodId: 'pm-1', expectedTotal: 257.25 }),
      });

      expect(response.status).toBe(200);
      expect(StripeService.chargeInvoiceWithSavedCard).toHaveBeenCalledWith(
        'inv-1',
        'pm-1',
        { expectedTotal: 257.25 },
      );
    });
  });

  test('returns a terminal conflict when Stripe charged but the ledger write failed', async () => {
    const error = Object.assign(new Error('post-charge write failed'), {
      code: 'STRIPE_CHARGED_DB_FAILED',
      stripePaymentIntentId: 'pi_orphan_1',
    });
    StripeService.chargeInvoiceWithSavedCard.mockRejectedValue(error);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/invoices/inv-1/charge-card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethodId: 'pm-1' }),
      });
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body).toEqual(expect.objectContaining({
        code: 'STRIPE_CHARGED_DB_FAILED',
        orphan: true,
        stripe_payment_intent_id: 'pi_orphan_1',
      }));
      expect(body.error).toMatch(/DO NOT charge again/i);
    });
  });

  test('returns a terminal conflict when Stripe may have processed the charge', async () => {
    StripeService.chargeInvoiceWithSavedCard.mockRejectedValue(Object.assign(
      new Error('connection closed after write'),
      { code: 'STRIPE_AMBIGUOUS_OUTCOME' },
    ));

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/invoices/inv-1/charge-card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethodId: 'pm-1' }),
      });
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body).toEqual(expect.objectContaining({
        code: 'STRIPE_AMBIGUOUS_OUTCOME',
        ambiguous: true,
      }));
      expect(body.error).toMatch(/DO NOT charge again/i);
    });
  });

  test('keeps a deterministic decline retryable', async () => {
    StripeService.chargeInvoiceWithSavedCard.mockRejectedValue(new Error('Card declined'));

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/invoices/inv-1/charge-card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethodId: 'pm-1' }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Card declined' });
    });
  });

  test('returns a terminal conflict while a durable charge claim is active', async () => {
    StripeService.chargeInvoiceWithSavedCard.mockRejectedValue(Object.assign(
      new Error('charge already claimed'),
      { code: 'STRIPE_CHARGE_IN_PROGRESS' },
    ));

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/invoices/inv-1/charge-card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethodId: 'pm-1' }),
      });
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body).toEqual(expect.objectContaining({
        code: 'STRIPE_CHARGE_IN_PROGRESS',
        in_progress: true,
      }));
      expect(body.error).toMatch(/DO NOT charge again/i);
    });
  });
});
