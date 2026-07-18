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
jest.mock('../services/invoice', () => ({
  update: jest.fn(),
}));

const express = require('express');
const InvoiceService = require('../services/invoice');
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

// Every editability fence InvoiceService.update throws must surface as an
// operator-actionable 409 toast, never fall through to the generic 500
// handler. Pinned VERBATIM to the service's messages — rewording a fence
// without updating the route regex reintroduces exactly the failure this
// suite exists to catch (Codex #2828 r9 P2: the saved-card charge-attempt
// fence 500'd because the mapper didn't know its message).
describe('PUT /:id editability-conflict mapping', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([
    ['status fence', 'Only unpaid invoices can be edited — this invoice has been paid, is collecting payment, or is voided'],
    ['in-txn status re-check', 'Only unpaid invoices can be edited — its status or payment state changed while you were editing'],
    ['live PaymentIntent', 'A customer has already started paying this invoice — void it and create a replacement instead of editing'],
    ['annual prepay term', 'This invoice is part of an annual prepay term — edit the term (Annual prepay) instead of the invoice'],
    ['active payment plan', 'This invoice has an active payment plan — cancel the plan before editing the invoice'],
    ['payment-plan verify fail-closed', 'Could not verify the active payment plan state — refusing to edit (boom)'],
    ['dun send in flight', 'A payment reminder for this invoice is sending right now — try again in a minute'],
    ['payment applied', 'Cannot edit amounts on an invoice with payment already applied — refund it or issue a new invoice instead'],
    ['payment dispute', 'Cannot edit amounts on an invoice with a payment dispute in progress — resolve the dispute first'],
    ['saved-card charge attempt (r9 P2)', 'A saved-card charge for this invoice is still processing or awaiting reconciliation — wait for it to resolve before editing amounts'],
    ['saved-card verify fail-closed', 'Could not verify the saved-card charge state — refusing to edit (boom)'],
    ['deposit credit', "This invoice carries an estimate deposit credit — void it (the deposit returns to the customer's ledger) and create a replacement instead of editing line items"],
    ['account credit applied', 'This invoice has account credit applied (prepaid) — reverse the applied credit before editing line items'],
  ])('surfaces the %s fence as a 409 conflict', async (_label, message) => {
    InvoiceService.update.mockRejectedValue(new Error(message));

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/invoices/inv-1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ due_date: '2026-08-01' }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: message });
    });
  });

  test('a non-fence failure still surfaces as a server error (mapper is not over-broad)', async () => {
    InvoiceService.update.mockRejectedValue(new Error('connection refused'));

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/invoices/inv-1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ due_date: '2026-08-01' }),
      });

      expect(response.status).toBe(500);
    });
  });
});
